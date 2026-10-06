/**
 * Character Multi-View — host half.
 *
 * Responsibilities:
 *  - own the character library and the plugin config on disk
 *  - talk to the local ComfyUI (the browser cannot: a different port is a different
 *    origin, and ComfyUI does not send CORS headers)
 *  - run renders as tracked, pollable, cancellable runs
 *  - expose one JSON API to the panel UI over a web route
 *  - expose the same capabilities to the agent as tools
 */

import { createApi } from './api.js'
import { createToolsPlugin } from './tools.js'

export const name = 'characterViews'
/** `tools` is required; the web route is optional so headless profiles still work. */
export const inject = ['tools']

const ROUTE_PREFIX = '/characterviews-api'
/** A 24 MB photo is ~32 MB of base64, plus JSON overhead. */
const MAX_BODY_BYTES = 40 * 1024 * 1024

/** @param {import('node:http').IncomingMessage} req */
async function readJson(req, limit = MAX_BODY_BYTES) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) {
      const error = new Error(`请求体超过 ${limit} 字节`)
      error.code = 'body-too-large'
      throw error
    }
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    const error = new Error('请求体不是合法 JSON')
    error.code = 'bad-json'
    throw error
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload ?? null)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

export function apply(ctx) {
  const api = createApi(ctx)

  ctx.provide(name, api)

  ctx.effect(() => {
    const plugin = createToolsPlugin(api)
    /** @type {Array<() => void>} */
    const disposers = []
    // A scoped stand-in for the fiber: `tools` is the real registry, and each
    // `ctx.effect` a tool opens is collected here so unloading can dispose them all.
    //
    // The tools are registered inside a disposer rather than during load, on purpose.
    // `ctx.tools.register()` throws on a definition it does not accept, and a throw
    // while the plugin is loading takes the panel down with the tool — which is exactly
    // the failure this plugin was written to avoid repeating.
    const scoped = {
      effect(callback) { disposers.push(callback()) },
      tools: ctx.tools,
    }
    plugin.apply(scoped)
    return () => {
      for (const dispose of disposers.splice(0).reverse()) {
        try { dispose() } catch { /* a failed unregister must not block the rest */ }
      }
    }
  }, 'characterviews.tools')

  // Runs outlive no fiber: cancel in-flight renders on unload.
  ctx.effect(() => () => api.disposeRuns(), 'characterviews.runs')

  // The web half is a CHILD plugin that declares `webServer` as a hard dependency.
  //
  // Querying `ctx.get('webServer')` here instead would be a race: `ctx.get` never
  // waits, so if the carrier had not been provided yet the plugin would silently skip
  // its route and its index tap — tools working while the whole UI is dead, with
  // nothing in the logs to explain it. Declaring the dependency on a child gets both
  // behaviours right: absent carrier, the child stays PENDING and the agent tools
  // still work; present carrier, the child waits for it.
  ctx.plugin(webUiPlugin(api))
}

/**
 * The web-dependent half, as a child plugin.
 *
 * @param {object} api the shared implementation
 */
export function webUiPlugin(api) {
  return {
    name: 'characterViewsWebUi',
    inject: ['webServer'],
    apply(ctx) {
      const webServer = ctx.webServer

      // A per-process token, injected into the shell page. Without it any local
      // process could read this API; with it, only a page the harness actually served
      // can. Defence in depth on top of the loopback binding.
      const token = globalThis.crypto.randomUUID()

      // Hand the token to the page. Two mechanisms, deliberately:
      //
      // 1. The structured `webserver/index-inject` row is the first-class path the
      //    harness itself uses for boot data. It renders regardless of the exact
      //    markup, so it never depends on finding a `</head>` to splice into.
      // 2. `tapIndex` stays as a fallback for a composition whose SPA fallback renders
      //    raw HTML without collecting the structured table.
      //
      // Both write the same global, so whichever runs last wins with an identical
      // value. Neither can help a page loaded before they were registered — which is
      // why the client says "token missing" instead of failing mutely.
      ctx.on('webserver/index-inject', (table) => {
        table.push({ kind: 'global', name: '__CHARACTERVIEWS__', value: { token, prefix: ROUTE_PREFIX } })
      })

      ctx.effect(() => webServer.tapIndex((html) => {
        const boot = `<script>globalThis.__CHARACTERVIEWS__=${JSON.stringify({ token, prefix: ROUTE_PREFIX })}</script>`
        if (html.includes('</head>')) return html.replace('</head>', `${boot}</head>`)
        return boot + html
      }), 'characterviews.index-injection')

      ctx.effect(() => webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        async handler(req, res) {
          const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
          const route = url.pathname.slice(ROUTE_PREFIX.length) || '/'
          const seg = route.split('/').filter(Boolean)
          const method = req.method === 'POST' ? 'POST' : 'GET'

          // Images are fetched by <img> tags, which cannot set headers, so the token is
          // also accepted from the query string for asset reads only.
          const presented = req.headers['x-characterviews-token']
            ?? (seg[0] === 'asset' ? url.searchParams.get('t') : null)
          if (presented !== token) {
            sendJson(res, 403, { ok: false, error: { code: 'forbidden', message: '缺少或错误的插件访问令牌' } })
            return
          }

          try {
            // ------------------------------------------------------------ config
            if (seg[0] === 'config' && method === 'GET') return sendJson(res, 200, { ok: true, config: await api.getConfig() })
            if (seg[0] === 'config' && method === 'POST') {
              const body = await readJson(req)
              return sendJson(res, 200, { ok: true, config: await api.saveConfig(body?.patch ?? body) })
            }

            // -------------------------------------------------------- diagnostics
            if (seg[0] === 'status') {
              return sendJson(res, 200, { ok: true, status: await api.status({ fresh: url.searchParams.get('fresh') === '1' }) })
            }
            if (seg[0] === 'models') return sendJson(res, 200, { ok: true, ...api.models() })
            if (seg[0] === 'upscale' && method === 'GET') return sendJson(res, 200, { ok: true, ...(await api.upscaleOptions()) })
            if (seg[0] === 'paths') return sendJson(res, 200, { ok: true, paths: api.paths() })
            if (seg[0] === 'test' && method === 'POST') {
              const body = await readJson(req)
              return sendJson(res, 200, await api.testConnection(body?.baseUrl))
            }

            // --------------------------------------------------------- characters
            if (seg[0] === 'characters' && seg.length === 1 && method === 'GET') {
              return sendJson(res, 200, { ok: true, characters: await api.listCharacters() })
            }
            if (seg[0] === 'characters' && seg.length === 1 && method === 'POST') {
              return sendJson(res, 200, { ok: true, character: await api.createCharacter(await readJson(req)) })
            }
            if (seg[0] === 'characters' && seg[1]) {
              const id = decodeURIComponent(seg[1])
              if (seg.length === 2 && method === 'GET') {
                const character = await api.getCharacter(id)
                return character
                  ? sendJson(res, 200, { ok: true, character })
                  : sendJson(res, 404, { ok: false, error: { code: 'not-found', message: '没有这个角色' } })
              }
              if (seg.length === 2 && method === 'POST') {
                const character = await api.updateCharacter(id, await readJson(req))
                return character
                  ? sendJson(res, 200, { ok: true, character })
                  : sendJson(res, 404, { ok: false, error: { code: 'not-found', message: '没有这个角色' } })
              }
              if (method === 'POST' && seg[2] === 'delete') {
                return sendJson(res, 200, await api.removeCharacter(id))
              }
              if (method === 'POST' && seg[2] === 'photo') {
                return sendJson(res, 200, await api.uploadPhoto({ ...(await readJson(req)), characterId: id }))
              }
              if (method === 'POST' && seg[2] === 'render') {
                return sendJson(res, 200, await api.startRender({ ...(await readJson(req)), characterId: id }))
              }
              if (method === 'POST' && seg[2] === 'upscale') {
                return sendJson(res, 200, await api.startUpscale({ ...(await readJson(req)), characterId: id }))
              }
              if (method === 'POST' && seg[2] === 'reveal') {
                const body = await readJson(req)
                return sendJson(res, 200, await api.reveal({
                  ...body,
                  characterId: id,
                  assetId: seg[3] ? decodeURIComponent(seg[3]) : null,
                }))
              }
              if (method === 'POST' && seg[2] === 'export') {
                const body = await readJson(req)
                return sendJson(res, 200, await api.exportAsset({ ...body, characterId: id }))
              }
              if (method === 'POST' && seg[2] === 'assets' && seg[4] === 'delete') {
                const body = await readJson(req)
                return sendJson(res, 200, await api.removeAsset(id, decodeURIComponent(seg[3]), body))
              }
            }

            // ---------------------------------------------------------- recycle bin
            if (seg[0] === 'trash') {
              if (seg.length === 1 && method === 'GET') {
                return sendJson(res, 200, { ok: true, ...(await api.listTrash()) })
              }
              if (seg.length === 1 && method === 'POST') {
                return sendJson(res, 200, await api.emptyTrash())
              }
              if (seg[1] && method === 'POST') {
                const entryId = decodeURIComponent(seg[1])
                if (seg[2] === 'restore') return sendJson(res, 200, await api.restoreTrash(entryId))
                if (seg[2] === 'delete') return sendJson(res, 200, await api.deleteTrashEntry(entryId))
              }
            }

            // --------------------------------------------------------------- runs
            if (seg[0] === 'runs' && seg.length === 1 && method === 'GET') {
              return sendJson(res, 200, { ok: true, runs: api.runList({ limit: 30 }) })
            }
            if (seg[0] === 'runs' && seg[1]) {
              const id = decodeURIComponent(seg[1])
              if (method === 'POST' && seg[2] === 'cancel') return sendJson(res, 200, await api.cancelRun(id))
              const run = api.runStatus(id)
              return run
                ? sendJson(res, 200, { ok: true, run })
                : sendJson(res, 404, { ok: false, error: { code: 'not-found', message: '没有这次运行' } })
            }

            // ------------------------------------------------------------- assets
            if (seg[0] === 'asset' && seg[1] && seg[2]) {
              const characterId = decodeURIComponent(seg[1])
              const assetId = decodeURIComponent(seg[2])
              const found = await api.assetBytes(characterId, assetId)
              if (!found) return sendJson(res, 404, { ok: false, error: { code: 'not-found', message: '找不到这张图' } })
              res.writeHead(200, {
                'content-type': found.contentType,
                'content-length': found.bytes.byteLength,
                // Artifacts are immutable once written; the id changes when re-rendered.
                'cache-control': 'private, max-age=31536000, immutable',
              })
              res.end(found.bytes)
              return undefined
            }

            return sendJson(res, 404, { ok: false, error: { code: 'no-route', message: `未知路由 ${method} ${route}` } })
          } catch (error) {
            const code = error?.code ?? 'failed'
            const status = code === 'bad-json' || code === 'body-too-large' ? 400 : 500
            sendJson(res, status, { ok: false, error: { code, message: String(error?.message ?? error) } })
          }
          return undefined
        },
      }), 'characterviews.web-route')

      ctx.logger?.info?.(`characterviews: panel API mounted at ${ROUTE_PREFIX}`)
    },
  }
}

export default { name, inject, apply }
