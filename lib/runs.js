/**
 * Background run registry.
 *
 * A render is minutes long, far longer than a comfortable HTTP request, so nothing
 * long-running happens inside a request: a caller starts a run, gets an id
 * immediately, and polls for progress.
 *
 * Runs are DURABLE. Artifacts are the real record of what was produced, but the run
 * list is the record of what was *asked for*, and losing it on every restart makes
 * the panel look like nothing was ever run. Restoration has one honest obligation: a
 * run persisted as `running` belonged to a process that no longer exists, so it comes
 * back as `interrupted` — not claiming to be in progress, and not silently deleted,
 * because "this was asked for and did not finish" is exactly what the operator needs
 * to see.
 */

const TERMINAL = new Set(['done', 'failed', 'cancelled', 'interrupted'])
const MAX_RETAINED = 40
/** Progress fires many times a second; writes are batched behind this. */
const SAVE_DEBOUNCE_MS = 800

export function createRunRegistry(options = {}) {
  const onChange = typeof options.onChange === 'function' ? options.onChange : null
  /** @type {Map<string, object>} */
  const runs = new Map()
  let timer = null
  let restoring = true

  for (const record of Array.isArray(options.initial) ? options.initial : []) {
    if (!record || typeof record.id !== 'string') continue
    const interrupted = record.status === 'running'
    runs.set(record.id, {
      ...record,
      status: interrupted ? 'interrupted' : record.status,
      phase: interrupted ? 'interrupted' : record.phase,
      message: interrupted ? '插件重启时中断' : record.message,
      error: interrupted
        ? { code: 'interrupted', message: '插件重启，这次运行被中断，产物可能不完整' }
        : record.error ?? null,
      finishedAt: interrupted ? Date.now() : record.finishedAt ?? null,
      // The controller belonged to the dead process and cannot be resumed.
      controller: null,
    })
  }
  restoring = false

  /** Serialisable projection: never leak the controller or a raw Error. */
  function view(run) {
    return {
      id: run.id,
      kind: run.kind,
      label: run.label,
      characterId: run.characterId ?? null,
      status: run.status,
      phase: run.phase,
      message: run.message,
      current: run.current,
      total: run.total,
      /**
       * Steps inside the CURRENT generation, from ComfyUI's WebSocket.
       *
       * Deliberately separate from `current`/`total`, which count finished generations.
       * Conflating them is why a 25-step image used to sit at 0% and then jump to 100%:
       * polling `/queue` and `/history` can only see the second kind.
       */
      sampling: run.sampling ?? null,
      result: run.status === 'done' ? run.result : null,
      error: run.error ?? null,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt ?? null,
      // The ComfyUI job backing this run, once it has one. Exposed rather than kept
      // private because a caller that wants to stop it needs exactly this id.
      promptId: run.promptId ?? null,
      elapsedMs: (run.finishedAt ?? Date.now()) - run.startedAt,
    }
  }

  function persistNow() {
    if (!onChange) return
    try {
      onChange([...runs.values()].map(view))
    } catch { /* persistence is best-effort; it must never break a render */ }
  }

  function scheduleSave() {
    if (!onChange || restoring) return
    if (timer) return
    timer = setTimeout(() => { timer = null; persistNow() }, SAVE_DEBOUNCE_MS)
    // Do not hold the event loop open for a progress write.
    timer.unref?.()
  }

  function prune() {
    if (runs.size <= MAX_RETAINED) return
    const finished = [...runs.values()]
      .filter((run) => TERMINAL.has(run.status))
      .sort((a, b) => a.startedAt - b.startedAt)
    for (const run of finished) {
      if (runs.size <= MAX_RETAINED) break
      runs.delete(run.id)
    }
  }

  if (runs.size > 0) persistNow()

  return {
    /**
     * @param {object} spec
     * @param {string} spec.kind
     * @param {string} spec.label human-readable, shown in the queue
     * @param {string} [spec.characterId]
     * @param {(context:{progress:(update:object)=>void, signal:AbortSignal, runId:string}) => Promise<unknown>} spec.work
     * @returns {string} runId
     */
    start(spec) {
      const id = `run-${globalThis.crypto.randomUUID().slice(0, 8)}`
      const controller = new AbortController()
      const run = {
        id,
        kind: spec.kind ?? 'task',
        label: spec.label ?? 'task',
        characterId: spec.characterId ?? null,
        status: 'running',
        phase: 'starting',
        message: '',
        current: 0,
        total: 0,
        result: null,
        error: null,
        startedAt: Date.now(),
        finishedAt: null,
        controller,
      }
      runs.set(id, run)
      prune()
      persistNow()

      const progress = (update = {}) => {
        if (TERMINAL.has(run.status)) return
        if (update.phase !== undefined) run.phase = update.phase
        if (update.message !== undefined) run.message = update.message
        if (update.current !== undefined) run.current = update.current
        if (update.total !== undefined) run.total = update.total
        // Step-level progress arrives many times a second; it is kept as a whole object so
        // "the step counter no longer applies" is expressible as a single null.
        if (update.sampling !== undefined) run.sampling = update.sampling
        scheduleSave()
      }

      // Detached on purpose: the caller only ever holds the id.
      Promise.resolve()
        .then(() => spec.work({ progress, signal: controller.signal, runId: id }))
        .then((result) => {
          if (run.status === 'cancelled') return
          run.status = 'done'
          run.phase = 'done'
          run.result = result ?? null
        })
        .catch((error) => {
          if (run.status === 'cancelled') return
          run.status = 'failed'
          run.phase = 'failed'
          run.error = { code: error?.code ?? 'error', message: String(error?.message ?? error) }
        })
        .finally(() => {
          run.finishedAt = Date.now()
          run.controller = null
          if (timer) { clearTimeout(timer); timer = null }
          persistNow()
        })

      return id
    },

    get(id) {
      const run = runs.get(String(id ?? ''))
      return run ? view(run) : null
    },

    /**
     * Attach a fact discovered mid-run — today, the ComfyUI prompt id.
     *
     * Cancelling has to reach the QUEUE, not just this process: without the prompt id
     * the abort only stops the poll while ComfyUI keeps sampling a render nobody is
     * waiting for, and the GPU slot stays occupied. The id does not exist when the run
     * starts, so it is recorded the moment it does.
     */
    patch(id, fields = {}) {
      const run = runs.get(String(id ?? ''))
      if (!run) return false
      Object.assign(run, fields)
      return true
    },

    /** Newest first. */
    list({ limit = 20 } = {}) {
      return [...runs.values()]
        .sort((a, b) => b.startedAt - a.startedAt)
        .slice(0, limit)
        .map(view)
    },

    cancel(id) {
      const run = runs.get(String(id ?? ''))
      if (!run) return { ok: false, error: { code: 'not-found', message: `没有这次运行「${id}」` } }
      if (TERMINAL.has(run.status)) return { ok: false, error: { code: 'already-finished', message: `这次运行已经是 ${run.status} 了` } }
      run.status = 'cancelled'
      run.phase = 'cancelled'
      run.message = '已按请求取消'
      run.finishedAt = Date.now()
      try { run.controller?.abort() } catch { /* already gone */ }
      run.controller = null
      if (timer) { clearTimeout(timer); timer = null }
      persistNow()
      return { ok: true }
    },

    /** Abort everything; used on plugin unload so work does not outlive the fiber. */
    dispose() {
      for (const run of runs.values()) {
        if (TERMINAL.has(run.status)) continue
        run.status = 'cancelled'
        run.phase = 'cancelled'
        run.error = { code: 'aborted', message: '插件已卸载' }
        run.finishedAt = Date.now()
        try { run.controller?.abort() } catch { /* already gone */ }
        run.controller = null
      }
      if (timer) { clearTimeout(timer); timer = null }
      persistNow()
      runs.clear()
    },
  }
}

export default createRunRegistry
