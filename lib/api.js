/**
 * The single implementation behind both front doors.
 *
 * Every capability is a method here; `index.js` exposes them over the plugin's web
 * route for the panel UI, and `tools.js` exposes them as agent tools. One
 * implementation means the UI and the agent can never drift apart.
 *
 * Nothing long-running happens inline: a render starts a tracked run and returns its
 * id immediately, and the caller polls `runStatus`.
 */
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises'
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { ComfyClient, MODEL_CATEGORIES } from './comfy/client.js'
import { buildCharacterViewGraph, buildUpscaleGraph, describeGraph, validateGraph, UPSCALE_NODES } from './comfy/graph.js'
import {
  IMAGE_PREFERRED, IMAGE_PRESETS, presetFor, assessCapacity,
  UPSCALE_FACTORS, upscalePlan, upscaleCeiling, resolveUpscaleModel,
} from './comfy/preferred.js'
import {
  MODES, VIEWPOINTS, LAYOUTS, ASPECTS, EDGES,
  planViews, describePlan, canvasFor, viewPixels, sheetGrid,
} from './angles.js'
import {
  readConfig, writeConfig, mergeConfig, pluginRootDir, charactersDir, characterDir, storePath,
  safeSegment, DEFAULT_CONFIG,
} from './config.js'
import { createRunRegistry } from './runs.js'
import { createStore, loadIndex, librarySize, guessExt, mediaTypeFor } from './store.js'
import * as trash from './trash.js'

/**
 * Width and height straight out of the file header.
 *
 * Deliberately not an image library. All this needs is two integers, and the alternative —
 * decoding the bitmap to learn its size — costs a full decode of a 4 MP picture on every
 * upscale request to find out something the first 30 bytes already say.
 *
 * PNG: an IHDR chunk that always sits at a fixed offset. JPEG: walk the segment markers to the
 * start-of-frame, because a JPEG can carry thumbnails and metadata before its dimensions, and
 * the first `SOF` is the one that describes the actual picture.
 *
 * @param {Uint8Array} bytes
 * @returns {{width:number, height:number}|null}
 */
export function probeImageSize(bytes) {
  if (!bytes || bytes.byteLength < 16) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

  // PNG: 89 50 4E 47 0D 0A 1A 0A, then the IHDR length and tag, then width and height.
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    if (bytes[12] !== 0x49 || bytes[13] !== 0x48 || bytes[14] !== 0x44 || bytes[15] !== 0x52) return null
    return { width: view.getUint32(16), height: view.getUint32(20) }
  }

  // JPEG: FF D8, then a chain of FF xx segments.
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2
    while (offset + 9 < bytes.byteLength) {
      if (bytes[offset] !== 0xff) { offset += 1; continue }
      const marker = bytes[offset + 1]
      // Padding and standalone markers carry no length field.
      if (marker === 0xff || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) { offset += 2; continue }
      const length = (bytes[offset + 2] << 8) | bytes[offset + 3]
      // SOF0..SOF15, excluding the four that are not frame headers.
      const isFrame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)
      if (isFrame) {
        return { height: (bytes[offset + 5] << 8) | bytes[offset + 6], width: (bytes[offset + 7] << 8) | bytes[offset + 8] }
      }
      if (length <= 0) return null
      offset += 2 + length
    }
    return null
  }

  // WebP: RIFF....WEBP, then a VP8/VP8L/VP8X chunk that carries the size in its own way.
  if (bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    const tag = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15])
    if (tag === 'VP8X') {
      const width = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16))
      const height = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16))
      return { width, height }
    }
    if (tag === 'VP8 ') {
      return {
        width: (bytes[26] | (bytes[27] << 8)) & 0x3fff,
        height: (bytes[28] | (bytes[29] << 8)) & 0x3fff,
      }
    }
    if (tag === 'VP8L') {
      const bits = bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24)
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
    }
  }

  return null
}

/**
 * Open a folder — optionally with one file selected — in the OS file manager.
 *
 * Two deliberate choices:
 *
 *  - `execFile` with an argument ARRAY, never a shell string. A generated filename can
 *    contain characters a shell would interpret, and "open a folder" must not be able
 *    to become "run a command".
 *  - The caller passes a path this module already derived from stored ids; a path from
 *    a request is never accepted.
 *
 * @returns {Promise<{ok:boolean, opened?:string, error?:object}>}
 */
async function revealPath(target, select) {
  if (!target) return { ok: false, error: { code: 'missing', message: '这个文件还不存在' } }
  if (select) {
    try {
      await stat(target)
    } catch {
      return { ok: false, error: { code: 'missing', message: '这个文件还不存在' } }
    }
  } else {
    // Creating it means the button works before the first render, which is exactly when
    // someone goes looking for where the output will land.
    try {
      await mkdir(target, { recursive: true })
    } catch {
      return { ok: false, error: { code: 'unwritable', message: '这个目录无法创建' } }
    }
  }

  let bin
  let args
  if (process.platform === 'win32') {
    bin = 'explorer.exe'
    args = select ? [`/select,${target}`] : [target]
  } else if (process.platform === 'darwin') {
    bin = 'open'
    args = select ? ['-R', target] : [target]
  } else {
    bin = 'xdg-open'
    args = [select ? dirname(target) : target]
  }

  return new Promise((resolve) => {
    execFile(bin, args, { windowsHide: true }, (error) => {
      // explorer.exe reports a non-zero exit even on success, so its status is not a
      // verdict. Only failing to launch it at all is.
      if (error && (error.code === 'ENOENT' || error.code === 'EACCES')) {
        resolve({ ok: false, error: { code: 'no-file-manager', message: `找不到可用的文件管理器（${bin}）` } })
        return
      }
      resolve({ ok: true, opened: target })
    })
  })
}

/** A filename prefix ComfyUI is happy with: no separators, no exotic characters. */
function safePrefix(text) {
  const cleaned = String(text ?? '')
    .replace(/[^A-Za-z0-9._\u4e00-\u9fa5-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40)
  return cleaned || 'view'
}

function timestamp() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

/** Pull the bytes out of a base64 data URL, or out of a raw base64 string. */
function decodeImage(body) {
  const dataUrl = typeof body?.dataUrl === 'string' ? body.dataUrl : null
  const raw = typeof body?.base64 === 'string' ? body.base64 : null
  const match = dataUrl ? /^data:([A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+);base64,(.+)$/s.exec(dataUrl) : null
  if (dataUrl && !match) return { error: { code: 'bad-image', message: '上传的数据不是合法的 base64 图片' } }
  const mime = match ? match[1] : 'image/png'
  const payload = match ? match[2] : raw
  if (!payload) return { error: { code: 'bad-image', message: '没有收到图片数据' } }
  if (!mime.startsWith('image/')) return { error: { code: 'bad-image', message: '只能上传图片' } }
  let bytes
  try {
    bytes = Buffer.from(payload, 'base64')
  } catch {
    return { error: { code: 'bad-image', message: '图片数据无法解码' } }
  }
  if (bytes.byteLength === 0) return { error: { code: 'bad-image', message: '图片是空的' } }
  // ComfyUI's /upload/image and the browser both handle this comfortably; far larger
  // files are almost certainly a mistake rather than an intent.
  if (bytes.byteLength > 24 * 1024 * 1024) return { error: { code: 'too-large', message: '图片超过 24 MB' } }
  return { bytes, mime }
}

/**
 * @param {object} [ctx] the plugin context; unused today, but the API is created from
 *   it so a future ctx service (logging, LLM) does not change every call site.
 */
export function createApi(ctx = {}) {
  void ctx
  const config = {
    /** @type {object|null} */
    current: null,
    async read() {
      if (!this.current) this.current = await readConfig()
      return this.current
    },
    async patch(patchBody) {
      const next = await writeConfig(mergeConfig(await this.read(), patchBody ?? {}))
      this.current = next
      return next
    },
  }

  // The run registry is restored synchronously: the panel must be able to show what was
  // asked for before it can show anything else.
  const runsPath = join(pluginRootDir(), 'runs.json')
  const runs = createRunRegistry({
    initial: (() => {
      try {
        const parsed = JSON.parse(readFileSync(runsPath, 'utf8'))
        return Array.isArray(parsed) ? parsed : []
      } catch {
        return []
      }
    })(),
    onChange(records) {
      try {
        mkdirSync(dirname(runsPath), { recursive: true })
        const temp = `${runsPath}.${process.pid}.tmp`
        writeFileSync(temp, `${JSON.stringify(records.slice(0, 40), null, 2)}\n`, 'utf8')
        renameSync(temp, runsPath)
      } catch { /* run history is a convenience; never break a render over it */ }
    },
  })

  /** @type {ReturnType<typeof createStore>|null} */
  let store = null
  const storeReady = (async () => {
    store = createStore({ initial: await loadIndex() })
    return store
  })()

  /** Model resolution is cached briefly: it costs a full /object_info round trip. */
  let modelCache = { at: 0, value: null }

  function client() {
    return new ComfyClient({ baseUrl: config.current?.comfy?.baseUrl ?? DEFAULT_CONFIG.comfy.baseUrl })
  }

  async function resolveModels(fresh = false) {
    if (!fresh && modelCache.value && Date.now() - modelCache.at < 60_000) return modelCache.value
    const comfy = client()
    const lists = await comfy.modelLists()
    const cfg = await config.read()
    const picked = ComfyClient.resolveModels(lists, cfg.comfy.models, IMAGE_PREFERRED)
    const value = { lists, picked, resolvedAt: new Date().toISOString() }
    modelCache = { at: Date.now(), value }
    return value
  }

  /** The graph needs the cache node only if this ComfyUI has one. */
  async function hasCacheNode(comfy) {
    try {
      const info = await comfy.objectInfo('QwenImage21Cache')
      return Boolean(info?.QwenImage21Cache)
    } catch {
      return false
    }
  }

  async function outputRoot() {
    return (await config.read()).comfy.outputDir || charactersDir()
  }

  // -------------------------------------------------------------------------
  // Projections: the store holds the truth, the panel gets this shape.
  // -------------------------------------------------------------------------

  function publicAsset(asset, character) {
    return {
      id: asset.id,
      kind: asset.kind,
      ext: asset.ext,
      label: asset.label,
      viewpoint: asset.viewpoint,
      createdAt: asset.createdAt,
      bytes: asset.bytes,
      runId: asset.runId ?? null,
      batchId: asset.batchId ?? null,
      comfy: asset.comfy ?? null,
      source: asset.source ?? null,
      url: `/asset/${encodeURIComponent(character.id)}/${encodeURIComponent(asset.id)}`,
    }
  }

  function publicCharacter(character) {
    if (!character) return null
    return {
      id: character.id,
      name: character.name,
      notes: character.notes,
      dir: characterDir(character.name),
      createdAt: character.createdAt,
      updatedAt: character.updatedAt,
      lastRunId: character.lastRunId ?? null,
      batches: character.batches ?? [],
      assets: Object.values(character.assets ?? {})
        .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
        .map((a) => publicAsset(a, character)),
    }
  }

  const api = {
    // ------------------------------------------------------------- diagnostics

    async getConfig() {
      const cfg = await config.read()
      return { ...cfg, defaults: DEFAULT_CONFIG }
    },

    async saveConfig(patch) {
      const saved = await config.patch(patch)
      modelCache = { at: 0, value: null }
      return saved
    },

    models() {
      return {
        categories: Object.keys(MODEL_CATEGORIES),
        presets: Object.fromEntries(Object.entries(IMAGE_PRESETS).map(([k, v]) => [k, v.label])),
      }
    },

    /**
     * Everything the panel needs to decide whether it can render at all: is ComfyUI up,
     * does it have the node classes, are the model files installed, is there enough VRAM
     * to do it in reasonable time.
     */
    async status({ fresh = false } = {}) {
      const cfg = await config.read()
      const comfy = client()
      let health = null
      let healthError = null
      try {
        health = await comfy.health()
      } catch (error) {
        healthError = { code: error?.code ?? 'error', message: String(error?.message ?? error) }
      }

      let models = null
      let modelsError = null
      if (health) {
        try {
          models = await resolveModels(fresh)
        } catch (error) {
          modelsError = String(error?.message ?? error)
        }
      }

      const nodes = await api.capability()
      let upscale = { factors: UPSCALE_FACTORS, models: [], model: null, supported: false }
      if (health) {
        try {
          upscale = await api.upscaleOptions()
        } catch { /* reported as unsupported below */ }
      }
      const capacity = health ? assessCapacity(health) : null
      const paths = {
        pluginRoot: pluginRootDir(),
        characters: charactersDir(),
        outputRoot: cfg.comfy.outputDir || charactersDir(),
        libraryFile: storePath(),
        comfyOutput: health?.outputDir ?? null,
      }

      const problems = []
      if (healthError) problems.push(`连不上 ComfyUI（${cfg.comfy.baseUrl}）：${healthError.message}`)
      if (modelsError) problems.push(`读取模型列表失败：${modelsError}`)
      if (models && !models.picked.diffusionModel) problems.push('没有找到可用的扩散模型（需要 Qwen-Image 2.1 系列）')
      if (models && !models.picked.textEncoder) problems.push('没有找到可用的文本编码器（需要 qwen3vl 系列）')
      if (models && !models.picked.vae) problems.push('没有找到可用的 VAE（需要 qwen_image 系列）')
      for (const missing of nodes?.missing ?? []) {
        if (missing === 'LoraLoaderModelOnly' || missing === 'QwenImage21Cache') continue // both optional
        problems.push(`ComfyUI 缺少节点 ${missing}，这张图跑不起来`)
      }

      return {
        ok: problems.length === 0,
        comfy: health
          ? { ...health, nodes, models: models?.picked ?? null, modelLists: models?.lists ?? null }
          : { baseUrl: cfg.comfy.baseUrl, error: healthError, nodes },
        capacity,
        paths,
        libraryBytes: await librarySize(),
        config: cfg,
        problems,
        upscale,
        modes: Object.values(MODES),
        layouts: Object.values(LAYOUTS),
        viewpoints: Object.values(VIEWPOINTS),
        presets: Object.fromEntries(Object.entries(IMAGE_PRESETS).map(([k, v]) => [k, v.label])),
      }
    },

    /** Which node classes this ComfyUI actually has. */
    async capability() {
      const comfy = client()
      return comfy.capability([
        'UNETLoader', 'CLIPLoader', 'VAELoader', 'TextEncodeQwenImage21',
        'EmptyLatentImage', 'KSampler', 'VAEDecode', 'SaveImage', 'LoadImage',
        'QwenImage21Cache', 'LoraLoaderModelOnly',
      ])
    },

    async testConnection(baseUrl) {
      const comfy = client().withBaseUrl(baseUrl ?? (await config.read()).comfy.baseUrl)
      try {
        const health = await comfy.health()
        return { ok: true, health }
      } catch (error) {
        return { ok: false, error: { code: error?.code ?? 'error', message: String(error?.message ?? error) } }
      }
    },

    // --------------------------------------------------------------- characters

    async listCharacters() {
      return (await storeReady).list()
    },

    async getCharacter(id) {
      return publicCharacter((await storeReady).get(id))
    },

    async createCharacter(input = {}) {
      return publicCharacter(await (await storeReady).create(input))
    },

    async updateCharacter(id, patch = {}) {
      return publicCharacter(await (await storeReady).update(id, patch))
    },

    async removeCharacter(id) {
      return (await storeReady).remove(id)
    },

    /**
     * Delete one asset.
     *
     * `purge: true` is the "erase the photo's bytes too, do not bother with the bin" path.
     * It is off by default; the panel only sends it from the recycle-bin UI, where the
     * user is already looking at the file they are destroying.
     */
    async removeAsset(characterId, assetId, options = {}) {
      return (await storeReady).removeAsset(characterId, assetId, { purge: options?.purge === true })
    },

    // -------------------------------------------------------------- recycle bin

    async listTrash() {
      const listed = await trash.listTrash()
      return { ...listed, dir: trash.trashDir() }
    },

    async restoreTrash(entryId) {
      const s = await storeReady
      // The trash moves bytes; the store owns the index. Handing the store in as a hook
      // keeps the two from importing each other.
      return trash.restoreFromTrash(String(entryId ?? ''), {
        restoreRecord: (entry) => s.restoreAsset({
          characterId: entry.characterId,
          characterName: entry.characterName,
          assetId: entry.assetId,
          ext: entry.ext,
          label: entry.originalName,
          size: entry.size,
          viewpoint: entry.viewLabel,
        }),
      })
    },

    async deleteTrashEntry(entryId) {
      return trash.deleteTrashEntry(String(entryId ?? ''))
    },

    async emptyTrash() {
      return trash.emptyTrash()
    },

    // ------------------------------------------------------------------- photos

    /**
     * Store an uploaded photograph and attach it to a character.
     *
     * The image is kept byte-for-byte: it is usually a photo of a real person, and
     * re-encoding it would lose detail the whole point of supplying it was to keep. It
     * is also pushed to ComfyUI right away, because the graph references it by name in
     * ComfyUI's own input directory.
     */
    async uploadPhoto(request = {}) {
      const s = await storeReady
      const character = s.get(request.characterId)
      if (!character) return { ok: false, error: { code: 'not-found', message: '没有这个角色' } }

      const decoded = decodeImage(request)
      if (decoded.error) return { ok: false, error: decoded.error }

      const ext = guessExt(request.filename, decoded.mime)
      let comfyName = null
      let comfyError = null
      try {
        const uploaded = await client().uploadImage(decoded.bytes, `${safePrefix(character.name)}_ref_${timestamp()}.${ext}`)
        comfyName = uploaded.subfolder ? `${uploaded.subfolder}/${uploaded.name}` : uploaded.name
      } catch (error) {
        comfyError = String(error?.message ?? error)
      }

      const asset = await s.writeAsset(character.id, {
        kind: 'photo',
        ext,
        label: String(request.filename ?? '上传照片').slice(0, 120),
        viewpoint: null,
        comfy: comfyName ? { inputName: comfyName } : null,
      }, decoded.bytes)

      if (!asset) return { ok: false, error: { code: 'write-failed', message: '照片存盘失败' } }
      return {
        ok: true,
        asset,
        character: publicCharacter(s.get(character.id)),
        comfyName,
        // A photo stored locally but absent from ComfyUI's input directory is still
        // useful — it can be re-uploaded on the next render — so this is a warning, not
        // a failure.
        warning: comfyError ? `照片已存到本地，但没能上传给 ComfyUI：${comfyError}` : null,
      }
    },

    /** Re-send a stored photo to ComfyUI; its input directory may have been cleared. */
    async ensurePhotoInComfy(character, asset) {
      if (asset?.comfy?.inputName) {
        // A recorded name is not a promise: ComfyUI's input dir can be wiped between
        // sessions, and a stale name fails the graph with a red node.
        try {
          const listed = await client().inputOptions('LoadImage', 'image')
          if (listed.includes(asset.comfy.inputName)) return asset.comfy.inputName
        } catch { /* fall through and re-upload */ }
      }
      const found = await (await storeReady).readAsset(character.id, asset.id)
      if (!found) throw new Error('原始照片文件不见了，请重新上传')
      const uploaded = await client().uploadImage(found.bytes, `${safePrefix(character.name)}_ref_${timestamp()}.${asset.ext}`)
      const name = uploaded.subfolder ? `${uploaded.subfolder}/${uploaded.name}` : uploaded.name
      asset.comfy = { inputName: name }
      return name
    },

    // ---------------------------------------------------------------- rendering

    /**
     * Start a batch. Returns immediately with a run id.
     *
     * @param {object} request
     * @param {string} request.characterId
     * @param {'single'|'three'|'multi'|'custom'} request.mode
     * @param {'sheet'|'separate'} [request.layout]
     * @param {number} [request.yaw] @param {number} [request.pitch] single mode
     * @param {string[]} [request.views] custom mode
     * @param {number} [request.seed] 0/omitted = random
     * @param {number} [request.count] how many variations to render
     * @param {string} [request.notes] extra direction
     * @param {string} [request.photoAssetId] which photo to work from
     */
    async startRender(request = {}) {
      const s = await storeReady
      const cfg = await config.read()
      const character = s.get(request.characterId)
      if (!character) return { ok: false, error: { code: 'not-found', message: '没有这个角色' } }

      const photos = Object.values(character.assets).filter((a) => a.kind === 'photo')
      const photo = request.photoAssetId ? character.assets[request.photoAssetId] : photos[photos.length - 1]
      if (!photo) return { ok: false, error: { code: 'no-photo', message: '这个角色还没有照片，先上传一张' } }
      if (photo.kind !== 'photo') return { ok: false, error: { code: 'bad-photo', message: '指定的资源不是照片' } }

      const views = planViews(request)
      if (views.length === 0) return { ok: false, error: { code: 'no-views', message: '没有选择任何角度' } }
      const layout = request.layout === 'separate' || views.length === 1 ? 'separate' : 'sheet'

      // One job per generation. In sheet layout that is a single job holding every
      // angle; in separate layout it is one job per angle, which is what lets a single
      // bad view be re-rolled later without touching the good ones.
      const jobs = layout === 'sheet'
        ? [{ views, index: 0, label: views.map((v) => v.label).join(' + ') }]
        : views.map((view, index) => ({ views: [view], index, label: view.label }))

      const count = Math.max(1, Math.min(4, Number(request.count ?? 1) || 1))
      const preset = presetFor(cfg.comfy.preset)

      // Output geometry. The request may override either half of the configured resolution;
      // `canvasFor` owns the arithmetic, including the caps, and reports whether it had to
      // shrink the result — which the panel says out loud rather than silently handing back
      // a different size than was asked for.
      const resolution = {
        aspect: ASPECTS[request.aspect] ? request.aspect : cfg.comfy.resolution.aspect,
        edge: Number.isFinite(Number(request.edge)) && Number(request.edge) > 0
          ? Number(request.edge)
          : cfg.comfy.resolution.edge,
      }
      const canvas = canvasFor({
        aspect: resolution.aspect,
        edge: resolution.edge,
        layout,
        viewCount: views.length,
      })
      const baseSeed = Number.isFinite(Number(request.seed)) && Number(request.seed) > 0
        ? Math.floor(Number(request.seed))
        : Math.floor(Math.random() * 2 ** 31)

      const plan = describePlan({ views, layout, config: cfg, notes: request.notes })
      const batchId = `batch-${globalThis.crypto.randomUUID().slice(0, 8)}`

      const runId = runs.start({
        kind: 'render',
        label: `${MODES[request.mode]?.label ?? '出图'} · ${character.name} · ${plan.viewLabels.join('/')}`,
        characterId: character.id,
        async work({ progress, signal }) {
          const comfy = client()
          const cacheSupport = await hasCacheNode(comfy)
          const { picked } = await resolveModels()
          const inputName = await api.ensurePhotoInComfy(character, photo)

          progress({ phase: 'validating', message: '检查节点与模型…' })
          const build = (overrides) => buildCharacterViewGraph({
            models: picked,
            positive: plan.positive,
            negative: plan.negative,
            width: canvas.width,
            height: canvas.height,
            seed: baseSeed,
            steps: preset.steps,
            cfg: preset.cfg,
            samplerName: preset.samplerName,
            scheduler: preset.scheduler,
            turbo: preset.turbo,
            hasCacheNode: cacheSupport,
            referenceImages: [inputName],
            referenceResolution: cfg.comfy.referenceResolution,
            filenamePrefix: 'characterviews/probe',
            ...overrides,
          })

          const probe = build({})
          const check = await validateGraph(comfy, probe)
          if (!check.ok) {
            const error = new Error(`图不合法，ComfyUI 会拒绝它：\n- ${check.errors.join('\n- ')}`)
            error.code = 'invalid-graph'
            throw error
          }
          if (check.warnings.length > 0) progress({ message: check.warnings.join('；') })

          /** @type {{asset:object, label:string, variation:number, viewpoints:string[]}[]} */
          const produced = []
          const comfyOutputs = []

          for (let variation = 0; variation < count; variation += 1) {
            for (const job of jobs) {
              if (signal.aborted) throw new Error('已取消')
              const seed = (baseSeed + variation * 977 + job.index * 131) % 2 ** 31
              const prefix = safePrefix(`CV_${character.name}_${job.views.map((v) => v.key).join('-')}_${timestamp()}`)
              const graph = build({
                seed,
                filenamePrefix: `characterviews/${prefix}`,
              })

              progress({
                phase: 'sampling',
                message: `正在出图：${job.label}${count > 1 ? `（第 ${variation + 1}/${count} 张）` : ''}`,
                current: produced.length,
                total: jobs.length * count,
              })

              // A client id per job, so the WebSocket can tell this render's steps from
              // those of whatever else is queued behind it.
              const clientId = globalThis.crypto.randomUUID()
              const { promptId } = await comfy.submit(graph, clientId)
              // Recorded so a cancel can reach ComfyUI's queue while this is still
              // running — the run's own result does not exist yet.
              runs.patch(runId, { promptId })

              // Step-level progress, which polling cannot see. Deliberately does NOT write
              // `message`: the socket fires per step, and a message that changes on every
              // step would rewrite the run record constantly for no extra information.
              const stopWatch = comfy.watchExecution(clientId, promptId, ({ current, total }) => {
                progress({ sampling: { current, total }, total: jobs.length * count, current: produced.length })
              })

              let outcome
              try {
                outcome = await comfy.waitFor(promptId, {
                  signal,
                  timeoutMs: 30 * 60 * 1000,
                  onProgress: ({ elapsedMs, queuePosition }) => {
                    progress({
                      phase: queuePosition > 0 ? 'queued' : 'sampling',
                      message: queuePosition > 0
                        ? `排队中（第 ${queuePosition} 位，已等 ${Math.round(elapsedMs / 1000)}s）：${job.label}`
                        : `采样中（${Math.round(elapsedMs / 1000)}s）：${job.label}`,
                      // Cleared once the job is no longer sampling: a stale step count would
                      // leave the bar looking frozen between jobs.
                      sampling: queuePosition > 0 ? null : undefined,
                      current: produced.length,
                      total: jobs.length * count,
                    })
                  },
                })
              } finally {
                stopWatch()
              }

              if (outcome.status === 'failed') {
                const error = new Error(`ComfyUI 执行失败：${outcome.error ?? '未给出原因'}`)
                error.code = 'execution-failed'
                throw error
              }
              const images = outcome.outputs.filter((o) => o.kind === 'image')
              if (images.length === 0) {
                const error = new Error('这一次没有产出任何图片')
                error.code = 'no-output'
                throw error
              }

              for (const [index, file] of images.slice(0, 4).entries()) {
                const fetched = await comfy.view(file)
                const asset = await s.writeAsset(character.id, {
                  kind: 'view',
                  ext: guessExt(file.filename, fetched.contentType),
                  label: `${job.label}${variation > 0 ? ` · 变体 ${variation + 1}` : ''}${images.length > 1 ? ` #${index + 1}` : ''}`,
                  viewpoint: job.views.length === 1 ? job.views[0].key : job.views.map((v) => v.key).join('+'),
                  comfy: { filename: file.filename, subfolder: file.subfolder, type: file.type, promptId },
                  runId,
                  batchId,
                }, fetched.bytes)
                if (!asset) continue
                produced.push({ asset, label: job.label, variation, viewpoints: job.views.map((v) => v.key) })
                comfyOutputs.push({ ...file, promptId })
                progress({ current: produced.length, total: jobs.length * count, message: `已保存：${asset.label}` })
              }
            }
          }

          const batch = {
            id: batchId,
            runId,
            createdAt: new Date().toISOString(),
            mode: request.mode ?? 'three',
            layout,
            viewKeys: views.map((v) => v.key),
            viewLabels: views.map((v) => v.label),
            photoAssetId: photo.id,
            seed: baseSeed,
            steps: preset.steps,
            preset: cfg.comfy.preset,
            canvas,
            assetIds: produced.map((p) => p.asset.id),
            comfyFiles: comfyOutputs,
            prompt: plan.positive,
            negative: plan.negative,
          }
          await s.addBatch(character.id, batch)
          await s.update(character.id, { lastRunId: runId })

          return {
            batchId,
            characterId: character.id,
            charactersDir: characterDir(character.name),
            assetIds: produced.map((p) => p.asset.id),
            assets: produced.map((p) => publicAsset(p.asset, character)),
            canvas,
            steps: preset.steps,
            seed: baseSeed,
            layout,
            viewLabels: plan.viewLabels,
            comfyFiles: comfyOutputs,
            graph: describeGraph(probe),
            prompt: plan.positive,
            negative: plan.negative,
          }
        },
      })

      return {
        ok: true,
        runId,
        batchId,
        plan: {
          layout,
          viewLabels: plan.viewLabels,
          positive: plan.positive,
          negative: plan.negative,
          jobs: jobs.length,
          count,
          canvas,
          resolution,
          steps: preset.steps,
          preset: cfg.comfy.preset,
          seed: baseSeed,
        },
      }
    },

    /**
     * Upscale one rendered view, as a tracked run.
     *
     * The source is the ARCHIVED copy, not ComfyUI's own output file. Copying to the input
     * directory is one small write and it means the operation works whatever ComfyUI has done
     * with its output folder since the render — an upscale that fails because somebody cleared
     * a temp directory would be a bad trade for saving 1.5 MB of copying.
     *
     * @param {object} request
     * @param {string} request.characterId
     * @param {string} request.assetId
     * @param {number} request.factor one of {@link UPSCALE_FACTORS}
     */
    async startUpscale(request = {}) {
      const s = await storeReady
      const character = s.get(request.characterId)
      if (!character) return { ok: false, error: { code: 'not-found', message: '没有这个角色' } }

      const asset = character.assets[String(request.assetId ?? '')]
      if (!asset) return { ok: false, error: { code: 'not-found', message: '找不到这张图' } }
      if (asset.kind !== 'view') {
        return { ok: false, error: { code: 'wrong-kind', message: '只有生成的图能放大（照片本身就是原图，放大它没有意义）' } }
      }
      if (asset.source?.upscaled) {
        // Following the chain instead of refusing would quietly multiply the file size for a
        // gain nobody can see: the detail was already added by the first pass.
        return {
          ok: false,
          error: { code: 'already-upscaled', message: `这张已经是 ${asset.source.factor}× 放大过的了，请从原图放大` },
        }
      }

      const factor = UPSCALE_FACTORS.includes(Number(request.factor)) ? Number(request.factor) : 2
      const comfy = client()
      const available = await comfy.inputOptions('UpscaleModelLoader', 'model_name').catch(() => [])
      const model = resolveUpscaleModel(available, request.model ?? null)
      if (!model) {
        return {
          ok: false,
          error: { code: 'no-model', message: 'ComfyUI 里没有上采样模型。把 ESRGAN 系模型放进 models/upscale_models 就能用' },
        }
      }

      const found = await s.readAsset(character.id, asset.id)
      if (!found) return { ok: false, error: { code: 'missing-bytes', message: '这张图的文件不见了' } }
      const size = await probeImageSize(found.bytes)
      if (!size) return { ok: false, error: { code: 'bad-image', message: '读不出这张图的尺寸，无法计算放大结果' } }

      // The ceiling follows the memory that is free RIGHT NOW, not a constant: the same request
      // is reasonable on an idle machine and impossible next to a queued video render.
      let ceiling = null
      try {
        ceiling = upscaleCeiling((await comfy.health()).devices?.[0]?.vramFreeBytes)
      } catch { /* health is advisory; the default ceiling is conservative */ }
      const plan = upscalePlan(size, factor, ceiling)
      const runId = runs.start({
        kind: 'upscale',
        label: `放大 ${plan.factor}× · ${character.name} · ${asset.label}`,
        characterId: character.id,
        async work({ progress, signal }) {
          progress({ phase: 'uploading', message: '把源图交给 ComfyUI…' })
          const uploaded = await comfy.uploadImage(found.bytes, `CV_up_${timestamp()}_${asset.id}.${asset.ext}`)
          const inputName = uploaded.subfolder ? `${uploaded.subfolder}/${uploaded.name}` : uploaded.name

          const graph = buildUpscaleGraph({
            image: inputName,
            model,
            factor: plan.factor,
            targetWidth: plan.width,
            targetHeight: plan.height,
            filenamePrefix: `characterviews/up_${safePrefix(character.name)}_${safePrefix(String(plan.factor)).replace('.', 'p')}x`,
          })

          progress({ phase: 'validating', message: '检查节点与模型…' })
          const check = await validateGraph(comfy, graph)
          if (!check.ok) {
            const error = new Error(`图不合法，ComfyUI 会拒绝它：\n- ${check.errors.join('\n- ')}`)
            error.code = 'invalid-graph'
            throw error
          }

          progress({
            phase: 'upscaling',
            message: `正在放大到 ${plan.factor}×（${plan.width}×${plan.height}）…`,
          })
          const clientId = globalThis.crypto.randomUUID()
          const { promptId } = await comfy.submit(graph, clientId)
          runs.patch(runId, { promptId })

          const outcome = await comfy.waitFor(promptId, {
            signal,
            timeoutMs: 30 * 60 * 1000,
            onProgress: ({ elapsedMs, queuePosition }) => {
              progress({
                phase: queuePosition > 0 ? 'queued' : 'upscaling',
                message: queuePosition > 0
                  ? `排队中（第 ${queuePosition} 位，已等 ${Math.round(elapsedMs / 1000)}s）`
                  : `放大中（${Math.round(elapsedMs / 1000)}s）到 ${plan.factor}×`,
              })
            },
          })
          if (outcome.status === 'failed') {
            const error = new Error(`ComfyUI 执行失败：${outcome.error ?? '未给出原因'}`)
            error.code = 'execution-failed'
            throw error
          }
          const images = outcome.outputs.filter((o) => o.kind === 'image')
          if (images.length === 0) {
            const error = new Error('放大没有产出图片')
            error.code = 'no-output'
            throw error
          }

          const file = images[0]
          const fetched = await comfy.view(file)
          const written = await s.writeAsset(character.id, {
            kind: 'view',
            ext: guessExt(file.filename, fetched.contentType),
            label: `${asset.label} · ${plan.factor}×`,
            viewpoint: asset.viewpoint ?? null,
            comfy: { filename: file.filename, subfolder: file.subfolder, type: file.type, promptId },
            runId,
            source: {
              assetId: asset.id,
              label: asset.label,
              width: size.width,
              height: size.height,
              factor: plan.factor,
              requested: plan.requested,
              clamped: plan.clamped,
              model,
              upscaled: true,
            },
          }, fetched.bytes)
          if (!written) {
            const error = new Error('放大结果存盘失败')
            error.code = 'write-failed'
            throw error
          }

          const measured = await probeImageSize(fetched.bytes)
          return {
            asset: publicAsset(written, character),
            factor: plan.factor,
            requested: plan.requested,
            clamped: plan.clamped,
            reason: plan.reason,
            source: { width: size.width, height: size.height },
            output: measured ?? { width: plan.width, height: plan.height },
            model,
            charactersDir: characterDir(character.name),
          }
        },
      })

      return {
        ok: true,
        runId,
        plan: {
          ...plan,
          model,
          source: size,
        },
      }
    },

    /** Which upscale models and factors are on offer, for the panel's controls. */
    async upscaleOptions() {
      const comfy = client()
      const available = await comfy.inputOptions('UpscaleModelLoader', 'model_name').catch(() => [])
      // The ceiling is reported, not hidden: the panel uses it to show what each factor would
      // really produce, so a button never promises a size the machine will not deliver.
      let ceiling = null
      try {
        ceiling = upscaleCeiling((await comfy.health()).devices?.[0]?.vramFreeBytes)
      } catch { /* the default ceiling applies */ }
      return {
        factors: UPSCALE_FACTORS,
        models: available,
        model: resolveUpscaleModel(available),
        supported: available.length > 0,
        ceiling: ceiling ?? { maxPixels: null, maxEdge: null, known: false },
      }
    },

    /**
     * Cancel a run.
     *
     * Cancelling the WAIT is not cancelling the WORK: the poll is aborted, and then the
     * prompt is removed from ComfyUI's queue or interrupted — otherwise the GPU keeps
     * sampling a render nobody is waiting for and the queue slot stays occupied.
     */
    async cancelRun(runId) {
      const record = runs.get(runId)
      const runtimePromptId = record?.promptId ?? null
      const result = runs.cancel(runId)
      const promptIds = []
      // The in-flight prompt first: it is the one actually occupying the GPU. The
      // finished ones are cancelled too, in case a job was submitted and the poll
      // aborted before its id was recorded.
      if (runtimePromptId) promptIds.push(runtimePromptId)
      for (const file of record?.result?.comfyFiles ?? []) {
        if (file?.promptId && !promptIds.includes(file.promptId)) promptIds.push(file.promptId)
      }
      for (const promptId of promptIds) {
        try { await client().cancelPrompt(promptId) } catch { /* best effort */ }
      }
      return { ...result, stoppedPrompts: promptIds }
    },

    runList({ limit = 20 } = {}) {
      return runs.list({ limit })
    },

    runStatus(id) {
      return runs.get(id)
    },

    // -------------------------------------------------------------------- files

    /**
     * Open one of this plugin's own folders in the file manager.
     *
     * The target is always derived here from stored ids — never taken from the request —
     * so "open a folder" can never become "open any path on this machine".
     *
     * @param {object} request
     * @param {'trash'} [request.kind] the recycle bin instead of a character folder
     */
    async reveal(request = {}) {
      const s = await storeReady
      if (request.kind === 'trash') return revealPath(trash.trashDir(), false)
      if (request.assetId) {
        const target = s.pathFor(request.characterId, request.assetId)
        if (!target) return { ok: false, error: { code: 'not-found', message: '找不到这张图' } }
        return revealPath(target, true)
      }
      const character = s.get(request.characterId)
      if (character) return revealPath(await s.dirFor(character.id), false)
      return revealPath(await outputRoot(), false)
    },

    async assetBytes(characterId, assetId) {
      const found = await (await storeReady).readAsset(characterId, assetId)
      if (!found) return null
      return { bytes: found.bytes, contentType: mediaTypeFor(found.asset.ext), asset: found.asset }
    },

    /**
     * "Save" for an image that is already on disk.
     *
     * With a directory, the file is copied there under its own name. Without one, the
     * file manager opens with the file selected — which is what saving means to most
     * people once the bytes already exist.
     */
    async exportAsset(request = {}) {
      const s = await storeReady
      const source = s.pathFor(request.characterId, request.assetId)
      if (!source) return { ok: false, error: { code: 'not-found', message: '找不到这张图' } }
      const dir = typeof request.dir === 'string' && request.dir.trim() ? request.dir.trim() : null
      if (!dir) return revealPath(source, true)
      try {
        await mkdir(dir, { recursive: true })
        const destination = join(dir, basename(source))
        await writeFile(destination, await readFile(source))
        return { ok: true, saved: destination }
      } catch (error) {
        return { ok: false, error: { code: 'copy-failed', message: String(error?.message ?? error) } }
      }
    },

    /** Per-character on-disk size, for the panel footer. */
    libraryBytes() {
      return librarySize()
    },

    paths() {
      return {
        pluginRoot: pluginRootDir(),
        characters: charactersDir(),
        libraryFile: storePath(),
        home: homedir(),
      }
    },

    disposeRuns() {
      runs.dispose()
    },
  }

  return api
}

export { safeSegment, characterDir }
export default createApi
