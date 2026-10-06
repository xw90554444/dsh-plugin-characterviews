/**
 * Minimal ComfyUI HTTP client for the Character Multi-View host half.
 *
 * Only the routes this plugin needs (verified against ComfyUI v0.38.2):
 *   GET  /system_stats          version, devices, VRAM
 *   GET  /object_info[/<class>] node contracts and the enum lists of installed models
 *   POST /prompt                enqueue an API-format graph -> { prompt_id, number }
 *   GET  /history/<prompt_id>   execution result
 *   GET  /view                  fetch one output file's bytes
 *   POST /upload/image          send bytes into ComfyUI's input dir
 *   GET  /queue                 pending + running
 *   POST /interrupt             cancel the running job
 *   POST /queue {delete:[id]}   drop a queued job
 *
 * Kept dependency-free and structural: the browser cannot reach ComfyUI directly
 * (different port = different origin, and ComfyUI sends no CORS headers), so every
 * call in this file happens in the host process.
 */

/** Node classes whose enum inputs enumerate installed model files. */
export const MODEL_CATEGORIES = {
  diffusionModel: { classType: 'UNETLoader', input: 'unet_name' },
  textEncoder: { classType: 'CLIPLoader', input: 'clip_name' },
  vae: { classType: 'VAELoader', input: 'vae_name' },
  lora: { classType: 'LoraLoaderModelOnly', input: 'lora_name' },
}

export class ComfyError extends Error {
  /** @param {string} message @param {{code?:string, status?:number, detail?:unknown}} [info] */
  constructor(message, info = {}) {
    super(message)
    this.name = 'ComfyError'
    this.code = info.code ?? 'comfy-error'
    this.status = info.status
    this.detail = info.detail
  }
}

/**
 * @param {string} baseUrl
 * @returns {string} normalised, no trailing slash
 */
export function normaliseBaseUrl(baseUrl) {
  const raw = typeof baseUrl === 'string' && baseUrl.trim() ? baseUrl.trim() : 'http://127.0.0.1:8188'
  return raw.replace(/\/+$/, '')
}

/**
 * @param {string} baseUrl
 * @param {string} path
 * @param {URLSearchParams|Record<string,string>} [query]
 */
export function buildUrl(baseUrl, path, query) {
  const url = new URL(`${normaliseBaseUrl(baseUrl)}${path}`)
  if (query) {
    const params = query instanceof URLSearchParams ? query : new URLSearchParams(query)
    for (const [k, v] of params) url.searchParams.set(k, v)
  }
  return url.toString()
}

export class ComfyClient {
  /**
   * @param {object} [options]
   * @param {string} [options.baseUrl]
   * @param {number} [options.timeoutMs] per-request timeout
   */
  constructor(options = {}) {
    this.baseUrl = normaliseBaseUrl(options.baseUrl)
    this.timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 15000
    /** @type {Map<string, unknown>} short-lived object_info cache */
    this.cache = new Map()
  }

  withBaseUrl(baseUrl) {
    return new ComfyClient({ baseUrl, timeoutMs: this.timeoutMs })
  }

  /**
   * @param {string} path
   * @param {RequestInit & {query?: Record<string,string>, timeoutMs?: number}} [init]
   */
  async request(path, init = {}) {
    const { query, timeoutMs, ...rest } = init
    const url = buildUrl(this.baseUrl, path, query)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs ?? this.timeoutMs)
    if (rest.signal) {
      if (rest.signal.aborted) controller.abort()
      else rest.signal.addEventListener('abort', () => controller.abort(), { once: true })
    }
    try {
      const response = await fetch(url, { ...rest, signal: controller.signal })
      if (!response.ok) {
        const text = await response.text().catch(() => '')
        throw new ComfyError(`ComfyUI ${rest.method ?? 'GET'} ${path} failed: HTTP ${response.status}`, {
          code: 'http-error',
          status: response.status,
          detail: text.slice(0, 2000),
        })
      }
      return response
    } catch (error) {
      if (error instanceof ComfyError) throw error
      if (error?.name === 'AbortError') {
        throw new ComfyError(`ComfyUI ${path} timed out after ${timeoutMs ?? this.timeoutMs}ms`, { code: 'timeout' })
      }
      throw new ComfyError(`ComfyUI ${path} unreachable at ${this.baseUrl}: ${error?.message ?? error}`, {
        code: 'unreachable',
        detail: error,
      })
    } finally {
      clearTimeout(timer)
    }
  }

  async getJson(path, init) {
    return (await this.request(path, init)).json()
  }

  async postJson(path, body, init = {}) {
    return (await this.request(path, {
      ...init,
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
      body: JSON.stringify(body),
    })).json()
  }

  // -- diagnostics ---------------------------------------------------------

  /** Connection test for the settings page: version, GPU, VRAM, free RAM. */
  async health() {
    const started = Date.now()
    const stats = await this.getJson('/system_stats', { timeoutMs: 8000 })
    const devices = Array.isArray(stats?.devices) ? stats.devices : []
    const primary = devices[0] ?? {}
    const argv = Array.isArray(stats?.system?.argv) ? stats.system.argv : []
    return {
      ok: true,
      baseUrl: this.baseUrl,
      latencyMs: Date.now() - started,
      version: stats?.system?.comfyui_version ?? null,
      python: stats?.system?.python_version ?? null,
      torch: stats?.system?.pytorch_version ?? null,
      ramTotalBytes: stats?.system?.ram_total ?? null,
      ramFreeBytes: stats?.system?.ram_free ?? null,
      // ComfyUI Desktop does not report this field at all — it passes the directory on
      // the command line instead, so argv is the only place the answer exists there.
      outputDir: stats?.system?.output_directory ?? flagValue(argv, '--output-directory'),
      inputDir: flagValue(argv, '--input-directory'),
      argv,
      devices: devices.map((d) => ({
        name: d.name,
        type: d.type,
        vramTotalBytes: d.vram_total ?? null,
        vramFreeBytes: d.vram_free ?? null,
      })),
    }
  }

  // -- object_info ---------------------------------------------------------

  /** @param {string} [classType] omit for the full (large) catalog */
  async objectInfo(classType, options = {}) {
    const key = classType ?? '*'
    if (!options.fresh && this.cache.has(key)) return this.cache.get(key)
    const data = await this.getJson(classType ? `/object_info/${classType}` : '/object_info', {
      timeoutMs: options.timeoutMs ?? 30000,
    })
    this.cache.set(key, data)
    return data
  }

  clearCache() { this.cache.clear() }

  /**
   * The enum options of one node input, e.g. every installed UNET file.
   *
   * Two shapes have to be handled, because ComfyUI changed the wire format and both are live in
   * the same process:
   *
   *   legacy  `"vae_name": [["a.safetensors", "b.safetensors"], {}]`      options in slot 0
   *   current `"model_name": ["COMBO", { "options": ["a.pth"] }]`         options in slot 1
   *
   * Reading only the legacy shape does not fail loudly — it returns an empty list, which looks
   * exactly like "nothing is installed". That is what happened here: `VAELoader` and
   * `UpscaleModelLoader` come from different code paths in the same ComfyUI build, so the image
   * models resolved fine while upscaling reported no upscale model existed.
   */
  async inputOptions(classType, inputName) {
    const info = await this.objectInfo(classType)
    const node = info?.[classType]
    const spec = node?.input?.required?.[inputName] ?? node?.input?.optional?.[inputName]
    if (!Array.isArray(spec)) return []
    for (const candidate of [spec[0], spec[1]?.options]) {
      if (Array.isArray(candidate)) return candidate.filter((v) => typeof v === 'string')
    }
    return []
  }

  /**
   * Every model list this plugin binds against.
   * Each list is fetched independently so one missing node class cannot empty the rest.
   */
  async modelLists() {
    const entries = Object.entries(MODEL_CATEGORIES)
    const lists = {}
    await Promise.all(entries.map(async ([category, spec]) => {
      try {
        lists[category] = await this.inputOptions(spec.classType, spec.input)
      } catch {
        lists[category] = []
      }
    }))
    return lists
  }

  /**
   * Is the node graph this plugin builds actually executable here?
   *
   * Reported up front rather than discovered after a queue, because the two
   * failures it catches — a missing node class and a missing model file — otherwise
   * surface only as a red node in the ComfyUI UI.
   *
   * @param {string[]} classTypes
   */
  async capability(classTypes) {
    let info
    try {
      info = await this.objectInfo(undefined, { timeoutMs: 60000 })
    } catch (error) {
      return { ok: false, classes: {}, missing: classTypes, error: String(error?.message ?? error) }
    }
    const classes = {}
    const missing = []
    for (const classType of classTypes) {
      const node = info?.[classType]
      if (!node) { missing.push(classType); continue }
      classes[classType] = {
        required: Object.keys(node.input?.required ?? {}),
        optional: Object.keys(node.input?.optional ?? {}),
      }
    }
    return { ok: missing.length === 0, classes, missing, knownClasses: Object.keys(info ?? {}).length }
  }

  /** Pick installed files for the graph's model slots, honouring explicit overrides. */
  static resolveModels(lists, overrides = {}, preferred = {}) {
    const picked = {}
    for (const category of Object.keys(MODEL_CATEGORIES)) {
      const available = lists?.[category] ?? []
      const override = overrides?.[category]
      if (override && available.includes(override)) { picked[category] = override; continue }
      let match
      for (const hint of preferred[category] ?? []) {
        match = available.find((name) => name.toLowerCase().includes(hint.toLowerCase()))
        if (match) break
      }
      picked[category] = match ?? available[0] ?? null
    }
    return picked
  }

  // -- execution -----------------------------------------------------------

  /**
   * Enqueue an API-format graph.
   * @returns {Promise<{promptId:string, number:number, nodeErrors:object}>}
   */
  async submit(graph, clientId) {
    const data = await this.postJson('/prompt', {
      prompt: graph,
      client_id: clientId ?? globalThis.crypto.randomUUID(),
    }, { timeoutMs: 30000 })
    if (data?.error) {
      throw new ComfyError(`ComfyUI 拒绝了这张图：${describeNodeErrors(data.node_errors) || JSON.stringify(data.error)}`, {
        code: 'graph-rejected',
        detail: data,
      })
    }
    if (!data?.prompt_id) {
      throw new ComfyError('ComfyUI 接受了请求但没有返回 prompt_id', { code: 'no-prompt-id', detail: data })
    }
    return { promptId: data.prompt_id, number: data.number ?? -1, nodeErrors: data.node_errors ?? {} }
  }

  /** @param {string} promptId */
  async history(promptId) {
    return this.getJson(`/history/${encodeURIComponent(promptId)}`, { timeoutMs: 15000 })
  }

  async queue() {
    return this.getJson('/queue', { timeoutMs: 10000 })
  }

  async interrupt() {
    await this.request('/interrupt', { method: 'POST', timeoutMs: 10000 })
    return true
  }

  /**
   * Stop ONE prompt, whether executing or still queued.
   *
   * The two cases need different calls and neither covers the other: /interrupt
   * takes no prompt id and stops whatever is running right now — which would be
   * someone else's job if ours has not started — while a queued prompt is removed
   * only by deleting it from the queue.
   */
  async cancelPrompt(promptId) {
    const result = { running: false, pending: false }
    if (!promptId) return result
    try {
      const q = await this.queue()
      result.running = (q?.queue_running ?? []).some((it) => it?.[1] === promptId)
      result.pending = (q?.queue_pending ?? []).some((it) => it?.[1] === promptId)
    } catch { /* the queue is advisory; try both below anyway */ }

    if (result.running) {
      try { await this.interrupt() } catch { /* best effort */ }
    }
    if (result.pending) {
      try { await this.postJson('/queue', { delete: [promptId] }, { timeoutMs: 10000 }) } catch { /* best effort */ }
    }
    return result
  }

  /**
   * Follow one prompt's execution over ComfyUI's WebSocket.
   *
   * Polling `/history` and `/queue` can only say "running" — the number of steps done
   * inside a generation is not in either payload, so a 25-step image showed a progress bar
   * stuck at 0% and then jumping to 100%. The step counter only exists on the socket.
   *
   * Best-effort by design: it returns a no-op unsubscribe when there is no `WebSocket`, and
   * a socket that never connects costs nothing but the progress detail — `waitFor` remains
   * the source of truth for when the job finished.
   *
   * @param {string} clientId the id the prompt was submitted with
   * @param {string} promptId
   * @param {(update:{current:number, total:number, node:string|null}) => void} onStep
   * @returns {() => void} unsubscribe
   */
  watchExecution(clientId, promptId, onStep) {
    const WebSocketImpl = globalThis.WebSocket
    if (typeof WebSocketImpl !== 'function' || !clientId || !promptId) return () => {}
    let socket
    let closed = false
    try {
      const url = buildUrl(this.baseUrl, '/ws', { clientId }).replace(/^http/, 'ws')
      socket = new WebSocketImpl(url)
    } catch {
      return () => {}
    }

    socket.addEventListener?.('message', (message) => {
      let parsed
      try {
        parsed = JSON.parse(typeof message.data === 'string' ? message.data : '')
      } catch {
        return // binary frames are previews, and not JSON at all
      }
      // Everything on this socket that matters is tagged with the prompt it belongs to;
      // without the check, a second queued render's steps would drive this one's bar.
      const data = parsed?.data ?? {}
      if (data.prompt_id && data.prompt_id !== promptId) return
      if (parsed?.type !== 'progress') return
      onStep({
        current: Number(data.value) || 0,
        total: Number(data.max) || 0,
        node: data.node ?? null,
      })
    })
    socket.addEventListener?.('error', () => { /* polling still covers completion */ })
    return () => {
      if (closed) return
      closed = true
      try { socket?.close() } catch { /* already closed */ }
    }
  }

  /**
   * Poll one prompt until it settles.
   *
   * A prompt that appears in NEITHER the queue NOR history has been lost —
   * ComfyUI was restarted, or its history cleared, while this job was in flight.
   * Without that check the poll runs to full timeout and the panel shows "working"
   * for a job that can no longer produce anything.
   *
   * @returns {Promise<{status:'completed'|'failed', outputs:object[], raw:object, elapsedMs:number}>}
   */
  async waitFor(promptId, options = {}) {
    const interval = options.intervalMs ?? 1500
    const timeout = options.timeoutMs ?? 30 * 60 * 1000
    const lostAfterMs = options.lostAfterMs ?? 90 * 1000
    const started = Date.now()
    let missingSince = null

    for (;;) {
      if (options.signal?.aborted) throw new ComfyError('已取消', { code: 'aborted' })
      const elapsed = Date.now() - started
      if (elapsed > timeout) {
        throw new ComfyError(`任务超过 ${Math.round(timeout / 1000)}s 仍未结束`, { code: 'timeout' })
      }

      const entry = (await this.history(promptId))?.[promptId]
      if (entry) {
        const status = entry?.status ?? {}
        const failed = status.status_str === 'error' || status.completed === false
        return {
          status: failed ? 'failed' : 'completed',
          outputs: collectOutputs(entry),
          raw: entry,
          elapsedMs: elapsed,
          error: failed ? describeExecutionError(entry) : null,
        }
      }

      let queuePosition = null
      try {
        const q = await this.queue()
        const running = Array.isArray(q?.queue_running) ? q.queue_running : []
        const pending = Array.isArray(q?.queue_pending) ? q.queue_pending : []
        if (running.some((it) => it?.[1] === promptId)) queuePosition = 0
        else {
          const idx = pending.findIndex((it) => it?.[1] === promptId)
          queuePosition = idx >= 0 ? idx + 1 : null
        }
      } catch { /* queue is advisory; history remains the source of truth */ }

      if (queuePosition !== null) missingSince = null
      else if (!missingSince) missingSince = Date.now()
      else if (Date.now() - missingSince > lostAfterMs) {
        throw new ComfyError(
          `任务既不在队列里也不在历史里（已 ${Math.round((Date.now() - missingSince) / 1000)}s）——`
          + 'ComfyUI 大概被重启过或历史被清空了，这个任务已经不存在。',
          { code: 'lost' },
        )
      }

      options.onProgress?.({ elapsedMs: elapsed, queuePosition })
      await new Promise((resolve) => setTimeout(resolve, interval))
    }
  }

  /**
   * Fetch one output file's bytes.
   * @param {{filename:string, subfolder?:string, type?:string}} ref
   */
  async view(ref) {
    const response = await this.request('/view', {
      query: {
        filename: ref.filename,
        subfolder: ref.subfolder ?? '',
        type: ref.type ?? 'output',
      },
      timeoutMs: 120000,
    })
    const bytes = new Uint8Array(await response.arrayBuffer())
    return { bytes, contentType: response.headers.get('content-type') ?? 'application/octet-stream' }
  }

  /**
   * Put bytes into ComfyUI's input directory.
   *
   * Invalidates the object_info cache on success: `LoadImage.image` is an enum of
   * the files in that directory, so a cached catalog would not list the file just
   * uploaded and a perfectly valid graph would be reported as broken.
   */
  async uploadImage(bytes, filename, options = {}) {
    const form = new FormData()
    form.append('image', new Blob([bytes]), filename)
    form.append('overwrite', String(options.overwrite ?? true))
    if (options.subfolder) form.append('subfolder', options.subfolder)
    const data = await (await this.request('/upload/image', {
      method: 'POST',
      body: form,
      timeoutMs: 120000,
    })).json()
    this.clearCache()
    return { name: data?.name ?? filename, subfolder: data?.subfolder ?? '', type: data?.type ?? 'input' }
  }
}

/**
 * Read `--flag value` out of a ComfyUI argv array.
 *
 * Both spellings are handled: `--flag value` and `--flag=value`, because ComfyUI's own
 * launcher and a hand-written command line do not agree on which one to use.
 *
 * @param {string[]} argv
 * @param {string} flag
 * @returns {string|null}
 */
function flagValue(argv, flag) {
  for (let i = 0; i < argv.length; i += 1) {
    const item = String(argv[i] ?? '')
    if (item === flag) {
      const next = argv[i + 1]
      return typeof next === 'string' && next ? next : null
    }
    if (item.startsWith(`${flag}=`)) return item.slice(flag.length + 1) || null
  }
  return null
}

/** Turn ComfyUI's node_errors payload into one readable line. */export function describeNodeErrors(nodeErrors) {
  const parts = []
  for (const [nodeId, info] of Object.entries(nodeErrors ?? {})) {
    for (const [input, detail] of Object.entries(info?.errors ?? {})) {
      parts.push(`节点 ${nodeId} (${info?.class_type ?? '?'}) 的 ${input}: ${detail?.message ?? detail?.type ?? '无效'}`)
    }
  }
  return parts.join('；')
}

/** The exception a failed execution carried, when it said anything useful. */
function describeExecutionError(entry) {
  const messages = entry?.status?.messages ?? []
  for (const item of messages) {
    const [kind, payload] = Array.isArray(item) ? item : []
    if (kind === 'execution_error' && payload) {
      const node = payload.node_type ?? payload.node_id ?? '?'
      return `${node}: ${payload.exception_message ?? payload.exception_type ?? '执行失败'}`
    }
    if (kind === 'execution_interrupted') return '执行被中断'
  }
  return null
}

/**
 * Flatten a history entry into a list of produced files.
 * @returns {{nodeId:string, kind:'image'|'video'|'audio'|'file', filename:string, subfolder:string, type:string}[]}
 */
export function collectOutputs(entry) {
  const out = []
  for (const [nodeId, node] of Object.entries(entry?.outputs ?? {})) {
    for (const [key, value] of Object.entries(node ?? {})) {
      if (!Array.isArray(value)) continue
      for (const item of value) {
        if (!item || typeof item !== 'object' || typeof item.filename !== 'string') continue
        out.push({
          nodeId,
          kind: kindFromFilename(item.filename, key),
          filename: item.filename,
          subfolder: item.subfolder ?? '',
          type: item.type ?? 'output',
        })
      }
    }
  }
  return out
}

function kindFromFilename(filename, key) {
  const ext = String(filename).toLowerCase().split('.').pop() ?? ''
  if (['mp4', 'webm', 'mkv', 'mov', 'gif'].includes(ext)) return 'video'
  if (['png', 'jpg', 'jpeg', 'webp'].includes(ext)) return 'image'
  if (['flac', 'wav', 'mp3', 'ogg', 'm4a'].includes(ext)) return 'audio'
  if (String(key).toLowerCase().includes('video')) return 'video'
  return 'file'
}

export default ComfyClient
