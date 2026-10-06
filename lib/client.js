/**
 * Character Multi-View — client half.
 *
 * Loaded as a combo script through `window.__ModuleLoader__`. It talks to the host
 * half over the plugin's own web route (there is no client service for
 * package-private RPC, and Typert remote descriptors would be far heavier than this
 * UI needs). The per-process token is injected into the shell page by the host, so
 * only a page the harness actually served can reach the route.
 *
 * The panel is one screen, not a wizard: photos and history on the left, the picture
 * on the right. A render is minutes long, so the UI's job is to make "what is it
 * doing" and "where did the file go" answerable at a glance.
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-characterviews',
  factory: function (require) {
    'use strict'
    const React = require('react')
    const h = React.createElement
    // `react-dom` is in the platform's static module seed (the same table that carries
    // `react`), so this resolves without an external declaration. Only `createPortal` is
    // taken: anything more would make the panel depend on a renderer it does not own.
    const { createPortal } = require('react-dom')

    // ---------------------------------------------------------------- theming

    const CSS = `
.cv-root{--cv-ink:var(--dsw-alias-label-primary,light-dark(#0f1115,#f9fafb));
--cv-muted:var(--dsw-alias-label-secondary,light-dark(#61666b,#cfd3d6));
--cv-line:var(--dsw-alias-border-l2,light-dark(#0000001a,#ffffff1f));
--cv-line-strong:var(--dsw-alias-border-l3,light-dark(#0000001f,#ffffff29));
--cv-surface:var(--dsw-alias-bg-module-platform,light-dark(#f9fafb,#353638));
--cv-surface-2:var(--dsw-specific-menu,light-dark(#f8f9fa,#2b2c2e));
--cv-accent:var(--dsw-alias-brand-primary,light-dark(#0f1115,#f9fafb));
--cv-accent-ink:var(--dsw-alias-label-primary-foreground,light-dark(#fff,#0f1115));
--cv-hover:var(--dsw-alias-interactive-bg-hover,light-dark(#2631480f,#ffffff14));
--cv-warn:light-dark(#8a5a00,#f0b429);--cv-err:light-dark(#b3261e,#ff8a80);--cv-ok:light-dark(#1a7f4b,#5ddc9a);
color:var(--cv-ink);display:flex;flex-direction:column;min-height:0;height:100%;font-size:13px;line-height:1.55}
.cv-root *{box-sizing:border-box}
.cv-head{display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid var(--cv-line);flex:0 0 auto;flex-wrap:wrap}
.cv-title{font-weight:600;font-size:14px;margin-right:auto;display:flex;align-items:center;gap:8px}
.cv-split{flex:1 1 auto;min-height:0;display:grid;grid-template-columns:minmax(280px,360px) minmax(0,1fr);gap:0}
@media (max-width:900px){.cv-split{grid-template-columns:minmax(0,1fr)}}
.cv-left{min-height:0;overflow:auto;padding:12px;border-right:1px solid var(--cv-line)}
.cv-right{min-height:0;overflow:auto;padding:12px;display:flex;flex-direction:column;gap:10px}
.cv-btn{appearance:none;font:inherit;cursor:pointer;border:1px solid var(--cv-line-strong);background:var(--cv-surface);
color:var(--cv-ink);padding:5px 11px;border-radius:7px;white-space:nowrap}
.cv-btn:hover:not(:disabled){background:var(--cv-hover)}
.cv-btn:disabled{opacity:.5;cursor:default}
.cv-btn[data-variant="primary"]{background:var(--cv-accent);color:var(--cv-accent-ink);border-color:transparent;font-weight:600}
.cv-btn[data-size="sm"]{padding:3px 8px;font-size:12px;border-radius:6px}
.cv-btn[data-tone="danger"]{color:var(--cv-err);border-color:currentColor}
.cv-row{display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap}
.cv-row.tight{gap:6px}
.cv-field{display:flex;flex-direction:column;gap:4px;min-width:0;flex:1 1 auto}
.cv-field>label{font-size:11px;color:var(--cv-muted);font-weight:600;letter-spacing:.02em;white-space:nowrap}
.cv-input,.cv-select,.cv-textarea{font:inherit;color:var(--cv-ink);background:var(--cv-surface);border:1px solid var(--cv-line-strong);
border-radius:7px;padding:5px 8px;min-width:0;width:100%}
.cv-textarea{resize:vertical;min-height:52px;font-family:inherit}
.cv-input:focus,.cv-select:focus,.cv-textarea:focus{outline:2px solid var(--cv-accent);outline-offset:-1px}
.cv-card{border:1px solid var(--cv-line);border-radius:10px;background:var(--cv-surface-2);padding:11px;margin-bottom:10px}
.cv-card>h3{margin:0 0 8px;font-size:13px;font-weight:600;display:flex;align-items:center;gap:6px}
.cv-card>h3 .cv-grow{flex:1 1 auto}
.cv-hint{color:var(--cv-muted);font-size:12px;margin:4px 0 0}
.cv-badge{display:inline-flex;align-items:center;gap:4px;font-size:11px;padding:1px 7px;border-radius:999px;
border:1px solid var(--cv-line-strong);color:var(--cv-muted);white-space:nowrap}
.cv-badge[data-tone="ok"]{color:var(--cv-ok);border-color:currentColor}
.cv-badge[data-tone="warn"]{color:var(--cv-warn);border-color:currentColor}
.cv-badge[data-tone="err"]{color:var(--cv-err);border-color:currentColor}
.cv-modes{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px}
.cv-mode{appearance:none;font:inherit;cursor:pointer;text-align:left;border:1px solid var(--cv-line-strong);
background:var(--cv-surface);color:var(--cv-ink);padding:7px 9px;border-radius:8px}
.cv-mode:hover{background:var(--cv-hover)}
.cv-mode[data-on="1"]{border-color:var(--cv-accent);box-shadow:inset 0 0 0 1px var(--cv-accent);font-weight:600}
.cv-mode small{display:block;color:var(--cv-muted);font-weight:400;font-size:11px;margin-top:2px;line-height:1.4}
.cv-slider{width:100%;accent-color:var(--cv-accent)}
.cv-chips{display:flex;flex-wrap:wrap;gap:5px}
.cv-chip{appearance:none;font:inherit;cursor:pointer;border:1px solid var(--cv-line-strong);background:var(--cv-surface);
color:var(--cv-ink);padding:3px 8px;border-radius:999px;font-size:12px}
.cv-chip:hover{background:var(--cv-hover)}
.cv-chip[data-on="1"]{background:var(--cv-accent);color:var(--cv-accent-ink);border-color:transparent;font-weight:600}
.cv-drop{border:1px dashed var(--cv-line-strong);border-radius:10px;padding:14px;text-align:center;color:var(--cv-muted);
cursor:pointer;background:var(--cv-surface)}
.cv-drop[data-over="1"]{border-color:var(--cv-accent);color:var(--cv-ink);background:var(--cv-hover)}
.cv-thumbs{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
.cv-thumb{position:relative;width:64px;height:64px;border-radius:8px;overflow:hidden;border:1px solid var(--cv-line-strong);
background:var(--cv-surface);cursor:pointer;padding:0;appearance:none}
.cv-thumb img{width:100%;height:100%;object-fit:cover;display:block}
.cv-thumb[data-on="1"]{outline:2px solid var(--cv-accent);outline-offset:-2px}
.cv-thumb .cv-thumb-x{position:absolute;top:1px;right:1px;border:0;border-radius:5px;background:#000000a8;color:#fff;
cursor:pointer;font-size:10px;line-height:1;padding:3px 4px}
.cv-stage{border:1px solid var(--cv-line);border-radius:10px;background:var(--cv-surface-2);padding:10px;display:flex;
flex-direction:column;gap:8px;min-height:240px}
.cv-stage-img{width:100%;max-height:60vh;object-fit:contain;border-radius:8px;background:
repeating-conic-gradient(from 0deg, var(--cv-surface) 0% 25%, transparent 0% 50%) 50%/18px 18px;display:block;margin:0 auto}
.cv-progress{height:6px;border-radius:999px;background:var(--cv-line);overflow:hidden}
.cv-progress>i{display:block;height:100%;background:var(--cv-accent);transition:width .3s ease}
.cv-gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px}
.cv-gcell{position:relative;min-width:0}
.cv-gitem{border:1px solid var(--cv-line);border-radius:9px;overflow:hidden;background:var(--cv-surface);padding:0;appearance:none;
cursor:pointer;text-align:left;color:var(--cv-ink);font:inherit;width:100%;display:block}
.cv-gitem img{width:100%;aspect-ratio:3/4;object-fit:cover;display:block;background:var(--cv-surface-2)}
.cv-gitem .cv-gmeta{padding:3px 6px;font-size:11px;color:var(--cv-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cv-gitem[data-on="1"]{outline:2px solid var(--cv-accent);outline-offset:-2px}
.cv-gtools{position:absolute;top:4px;right:4px;display:flex;gap:3px;opacity:0;transition:opacity .12s ease}
.cv-gcell:hover .cv-gtools,.cv-gcell:focus-within .cv-gtools{opacity:1}
.cv-gtool{appearance:none;border:0;border-radius:6px;background:#000000a8;color:#fff;cursor:pointer;
font-size:11px;line-height:1;padding:4px 5px}
.cv-gtool:hover{background:#000000d8}
/* The overlay is portalled into document.body, so it can be genuinely full-screen. The mask
   is deliberately opaque: this is a viewer, and the shell showing through it only competes
   with the picture being judged. */
.cv-lightbox{position:fixed;inset:0;z-index:2147483000;background:#08090bf2;display:flex;align-items:center;
justify-content:center;flex-direction:column;gap:10px;padding:16px 16px 10px;overflow:hidden}
/* Sized against the real viewport by the browser, on every resize. The old rule used 94vw
   measured from the WINDOW while the overlay was clipped to the PANEL, which is what made a
   wide sheet look cropped and a tall figure look cramped. */
.cv-lightbox-img{max-width:100%;max-height:100%;min-height:0;object-fit:contain;border-radius:8px;
background:#111;box-shadow:0 12px 48px #000000a6;transition:transform .06s linear;touch-action:none;
user-select:none;-webkit-user-drag:none}
.cv-lb-bar{display:flex;gap:8px;flex-wrap:wrap;justify-content:center;max-width:100%;flex:0 0 auto;
padding:6px 10px;border-radius:999px;background:#ffffff12;border:1px solid #ffffff24}
.cv-lb-bar .cv-btn{background:#ffffff1a;color:#fff;border-color:#ffffff40}
.cv-lb-bar .cv-btn:hover:not(:disabled){background:#ffffff2e}
.cv-lb-bar .cv-badge{color:#fff;border-color:#ffffff40}
.cv-lb-hint{color:#ffffff8a;font-size:11px;flex:0 0 auto}
.cv-upscale{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:6px;padding-top:6px;
border-top:1px solid var(--cv-line)}
.cv-upscale-label{font-size:11px;font-weight:600;color:var(--cv-muted);letter-spacing:.02em;white-space:nowrap}
.cv-chip-note{font-size:10px;opacity:.8;margin-left:3px}
.cv-upscale-confirm{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:5px 8px;border-radius:8px;
background:var(--cv-hover);border:1px solid var(--cv-line-strong)}
.cv-upscale-what{font-size:12px;font-weight:600;font-variant-numeric:tabular-nums}
.cv-monospace{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;word-break:break-all;
color:var(--cv-muted)}
.cv-err{color:var(--cv-err);font-size:12px;white-space:pre-wrap}
.cv-warn{color:var(--cv-warn);font-size:12px}
.cv-ok{color:var(--cv-ok)}
.cv-kv{display:grid;grid-template-columns:auto 1fr;gap:3px 10px;font-size:12px;margin:0}
.cv-kv dt{color:var(--cv-muted);white-space:nowrap}
.cv-kv dd{margin:0;min-width:0;word-break:break-all}
.cv-details{border-top:1px solid var(--cv-line);margin-top:8px;padding-top:8px}
.cv-details summary{cursor:pointer;color:var(--cv-muted);font-size:12px}
.cv-run{display:flex;flex-direction:column;gap:4px;padding:7px 9px;border:1px solid var(--cv-line);border-radius:8px;
background:var(--cv-surface);margin-bottom:6px}
.cv-run-top{display:flex;gap:8px;align-items:center}
.cv-run-top .cv-grow{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cv-empty{border:1px dashed var(--cv-line-strong);border-radius:10px;padding:22px;text-align:center;color:var(--cv-muted)}
.cv-empty b{display:block;color:var(--cv-ink);margin-bottom:4px;font-size:13px}
.cv-taskwrap,.cv-resizable{display:flex;flex-direction:column;min-height:0;margin-top:2px}
.cv-taskgrip{height:14px;display:flex;align-items:center;justify-content:center;cursor:ns-resize;
touch-action:none;user-select:none;border-radius:6px;flex:0 0 auto}
.cv-taskgrip:hover,.cv-taskgrip[data-dragging="1"]{background:var(--cv-hover)}
.cv-taskgrip>i{display:block;width:38px;height:3px;border-radius:999px;background:var(--cv-line-strong)}
.cv-taskgrip:hover>i,.cv-taskgrip[data-dragging="1"]>i{background:var(--cv-muted)}
.cv-taskgrip:focus-visible{outline:2px solid var(--cv-accent);outline-offset:-2px}
.cv-tasklist{overflow:auto;padding:2px 2px 2px 0;min-height:0;overscroll-behavior:contain}
.cv-taskfoot{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--cv-muted);
padding-top:5px;border-top:1px solid var(--cv-line);flex:0 0 auto}
.cv-run-meter{display:flex;align-items:center;gap:6px}
.cv-run-meter .cv-progress{flex:1 1 auto}
.cv-run-pct{font-size:10px;color:var(--cv-muted);font-variant-numeric:tabular-nums;white-space:nowrap;min-width:52px;text-align:right}
`

    function ensureStyles() {
      if (typeof document === 'undefined') return false
      if (document.getElementById('cv-style')) return true
      try {
        const element = document.createElement('style')
        element.id = 'cv-style'
        element.textContent = CSS
        // `head` is the documented place, but a document without one — or a head that is
        // not appendable yet — must not cost the panel its styling.
        const host = document.head ?? document.documentElement ?? document.body
        if (!host?.append) return false
        host.append(element)
        return true
      } catch {
        return false
      }
    }

    // Injected when the FACTORY runs, not when `apply()` does.
    //
    // `apply()` is the shell's call and happens on its schedule; the styling is a
    // property of this module merely existing. Deferring it meant a panel whose CSS
    // arrived late — or never — rendered as unstyled text on the shell's own
    // background, which reads as a blank screen even though nothing threw.
    ensureStyles()

    // ------------------------------------------------------------ transport

    function bridge() {
      const injected = globalThis.__CHARACTERVIEWS__
      if (!injected?.token) {
        // Reachable whenever the host half never wired its web route (a load-order
        // miss, say) — in that state every call below would fail, so say what is
        // actually wrong instead of "token missing".
        const error = new Error(
          '插件后端未就绪：页面里没有注入访问令牌。\n\n'
          + '这通常意味着宿主半边没有注册 Web 路由（可能是插件加载顺序问题）。\n'
          + '请先重启 DeepSeek Harness；仍不行就说明是插件缺陷，而不是你的操作问题。',
        )
        error.code = 'host-not-ready'
        throw error
      }
      return injected
    }

    async function call(method, path, body) {
      const { token, prefix } = bridge()
      const response = await fetch(`${prefix}${path}`, {
        method,
        headers: {
          'x-characterviews-token': token,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      let payload
      try {
        payload = await response.json()
      } catch {
        throw new Error(`角色多视图：${method} ${path} 返回了非 JSON 响应（HTTP ${response.status}）`)
      }
      if (payload?.error?.message && payload.ok !== true) {
        const error = new Error(payload.error.message)
        error.code = payload.error.code
        throw error
      }
      if (!response.ok) throw new Error(`角色多视图：${method} ${path} 失败（HTTP ${response.status}）`)
      return payload
    }

    const api = {
      status: (fresh) => call('GET', `/status${fresh ? '?fresh=1' : ''}`),
      getConfig: () => call('GET', '/config'),
      saveConfig: (patch) => call('POST', '/config', { patch }),
      test: (baseUrl) => call('POST', '/test', { baseUrl }),
      listCharacters: () => call('GET', '/characters'),
      getCharacter: (id) => call('GET', `/characters/${encodeURIComponent(id)}`),
      createCharacter: (input) => call('POST', '/characters', input),
      updateCharacter: (id, patch) => call('POST', `/characters/${encodeURIComponent(id)}`, patch),
      removeCharacter: (id) => call('POST', `/characters/${encodeURIComponent(id)}/delete`),
      removeAsset: (id, assetId, options) => call('POST', `/characters/${encodeURIComponent(id)}/assets/${encodeURIComponent(assetId)}/delete`, options ?? {}),
      listTrash: () => call('GET', '/trash'),
      emptyTrash: () => call('POST', '/trash'),
      restoreTrash: (entryId) => call('POST', `/trash/${encodeURIComponent(entryId)}/restore`),
      deleteTrashEntry: (entryId) => call('POST', `/trash/${encodeURIComponent(entryId)}/delete`),
      uploadPhoto: (id, payload) => call('POST', `/characters/${encodeURIComponent(id)}/photo`, payload),
      render: (id, payload) => call('POST', `/characters/${encodeURIComponent(id)}/render`, payload),
      upscale: (id, payload) => call('POST', `/characters/${encodeURIComponent(id)}/upscale`, payload),
      upscaleOptions: () => call('GET', '/upscale'),
      reveal: (id, assetId, kind) => call('POST', `/characters/${encodeURIComponent(id)}/reveal${assetId ? `/${encodeURIComponent(assetId)}` : ''}`, kind ? { kind } : undefined),
      exportAsset: (id, payload) => call('POST', `/characters/${encodeURIComponent(id)}/export`, payload),
      runs: () => call('GET', '/runs'),
      run: (id) => call('GET', `/runs/${encodeURIComponent(id)}`),
      cancelRun: (id) => call('POST', `/runs/${encodeURIComponent(id)}/cancel`),
      /** <img> cannot set headers, so asset URLs carry the token in the query string. */
      assetUrl: (characterId, assetId) => {
        const { token, prefix } = bridge()
        return `${prefix}/asset/${encodeURIComponent(characterId)}/${encodeURIComponent(assetId)}?t=${encodeURIComponent(token)}`
      },
    }

    // ------------------------------------------------------------- utilities

    function formatBytes(bytes) {
      const n = Number(bytes) || 0
      if (n < 1024) return `${n} B`
      if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`
      if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
      return `${(n / 1024 ** 3).toFixed(2)} GB`
    }

    function formatDuration(ms) {
      const s = Math.max(0, Math.round((Number(ms) || 0) / 1000))
      if (s < 60) return `${s}s`
      return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
    }

    function readFileAsDataUrl(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result ?? ''))
        reader.onerror = () => reject(new Error(`读不到文件 ${file?.name ?? ''}`))
        reader.readAsDataURL(file)
      })
    }

    const ANGLES = [
      { yaw: 0, pitch: 0, label: '正面' },
      { yaw: 90, pitch: 0, label: '右侧' },
      { yaw: 180, pitch: 0, label: '背面' },
      { yaw: 270, pitch: 0, label: '左侧' },
      { yaw: 0, pitch: 45, label: '俯视 45°' },
      { yaw: 0, pitch: -45, label: '仰视 45°' },
    ]

    const CUSTOM_VIEWS = [
      { key: 'front', label: '正面' },
      { key: 'frontLeft34', label: '左前 3/4' },
      { key: 'left', label: '左侧' },
      { key: 'backLeft34', label: '左后 3/4' },
      { key: 'back', label: '背面' },
      { key: 'backRight34', label: '右后 3/4' },
      { key: 'right', label: '右侧' },
      { key: 'frontRight34', label: '右前 3/4' },
      { key: 'low45', label: '仰视 45°' },
      { key: 'high45', label: '俯视 45°' },
      { key: 'topDown', label: '正俯视' },
    ]

    // ------------------------------------------------------------------ geometry
    //
    // Mirrored from `lib/angles.js`, which is the authority. Duplicated on purpose: the
    // size of the canvas has to be shown BEFORE a render is started, and a round trip per
    // keystroke to compute it would make the controls feel broken. The two are kept honest
    // by `verify-geometry.mjs`, which asserts they agree across every combination.

    const ASPECTS = [
      { key: 'square', label: '1:1', width: 1, height: 1 },
      { key: 'portrait', label: '3:4', width: 3, height: 4 },
      { key: 'photo', label: '4:5', width: 4, height: 5 },
      { key: 'tall', label: '2:3', width: 2, height: 3 },
      { key: 'landscape', label: '4:3', width: 4, height: 3 },
      { key: 'wide', label: '3:2', width: 3, height: 2 },
      { key: 'cinema', label: '16:9', width: 16, height: 9 },
    ]
    const EDGES = [512, 640, 768, 896, 1024, 1152, 1280, 1536, 2048]
    const MAX_EDGE = 2048
    const MAX_MEGAPIXELS = 4

    const snap32 = (value) => Math.max(256, Math.min(MAX_EDGE, Math.round(value / 32) * 32))

    /** The grid a multi-view sheet is laid out on: at most three figures per row. */
    function sheetGrid(viewCount) {
      const columns = viewCount <= 3 ? Math.max(1, viewCount) : 3
      return { columns, rows: Math.max(1, Math.ceil(viewCount / columns)) }
    }

    /**
     * The pixel size of one view. Only the LONG edge is snapped and the other side follows
     * from it — snapping both independently turns 1280 at 16:9 into 1280×736 instead of
     * 1280×720. Kept identical to `lib/angles.js#viewPixels`; `verify-geometry.mjs` asserts
     * the two agree over every combination.
     */
    function viewPixels(aspectKey, edge) {
      const aspect = ASPECTS.find((a) => a.key === aspectKey) ?? ASPECTS[1]
      const ratio = aspect.width / aspect.height
      const long = Math.max(256, Math.min(MAX_EDGE, Math.round(edge / 32) * 32))
      const short = Math.max(64, Math.round(long / (ratio >= 1 ? ratio : 1 / ratio)))
      return ratio >= 1 ? { width: long, height: short } : { width: short, height: long }
    }

    /**
     * Canvas for a plan. Same shape as the host's `canvasFor`, including `adjusted` —
     * an output that had to be shrunk is worth saying out loud rather than hiding.
     */
    function canvasFor(aspectKey, edge, layout, viewCount) {
      const asked = Number(edge) > 0 ? Number(edge) : 1024
      const single = layout === 'separate' || viewCount <= 1
      const grid = single ? { columns: 1, rows: 1 } : sheetGrid(viewCount)

      let candidate = asked
      let scale = 1
      let reason = null
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const view = viewPixels(aspectKey, candidate)
        // Not snapped again: `viewPixels` already carries the multiple of 32, and re-snapping
        // the canvas would push a 16:9 frame's 720 back up to 736.
        const width = Math.min(MAX_EDGE, view.width * grid.columns)
        const height = Math.min(MAX_EDGE, view.height * grid.rows)
        const megapixels = (width * height) / 1_000_000
        const overEdge = view.width > MAX_EDGE || view.height > MAX_EDGE || width > MAX_EDGE || height > MAX_EDGE
        const overBudget = megapixels > MAX_MEGAPIXELS + 1e-9
        if (!overEdge && !overBudget) {
          return {
            width,
            height,
            view,
            columns: grid.columns,
            rows: grid.rows,
            megapixels: Math.round(megapixels * 100) / 100,
            adjusted: Boolean(reason),
            reason,
          }
        }
        if (!reason) reason = overEdge ? `超过单边 ${MAX_EDGE}px 上限` : `超过 ${MAX_MEGAPIXELS}MP 预算`
        scale -= 0.05
        if (scale <= 0.1) break
        candidate = Math.max(256, Math.round(asked * scale))
      }
      const view = viewPixels(aspectKey, 256)
      const width = Math.min(MAX_EDGE, view.width * grid.columns)
      const height = Math.min(MAX_EDGE, view.height * grid.rows)
      return {
        width,
        height,
        view,
        columns: grid.columns,
        rows: grid.rows,
        megapixels: Math.round((width * height) / 10_000) / 100,
        adjusted: true,
        reason: reason ?? `已缩到 ${MAX_MEGAPIXELS}MP 以内`,
      }
    }

    function describeAngle(yaw, pitch) {
      const y = ((Math.round(Number(yaw) || 0) % 360) + 360) % 360
      const p = Math.max(-80, Math.min(80, Math.round(Number(pitch) || 0)))
      const head = y === 0 ? '正面' : y === 90 ? '右侧' : y === 180 ? '背面' : y === 270 ? '左侧'
        : y < 90 ? `右前 ${y}°` : y < 180 ? `右后 ${180 - y}°` : y < 270 ? `左后 ${y - 180}°` : `左前 ${360 - y}°`
      const tail = p === 0 ? '' : p > 0 ? ` · 俯视 ${p}°` : ` · 仰视 ${-p}°`
      return `${head}${tail}`
    }

    // ------------------------------------------------------------ components

    /**
     * The panel.
     *
     * State that belongs to the SERVER (characters, assets, runs) is re-read after
     * every mutation rather than patched locally. One authoritative fetch is cheaper
     * than four places that each have to remember to update themselves, and the only
     * cost is a round trip over loopback.
     */
    function Studio() {
      const [status, setStatus] = React.useState(null)
      const [characters, setCharacters] = React.useState([])
      const [activeId, setActiveId] = React.useState(null)
      const [character, setCharacter] = React.useState(null)
      const [runs, setRuns] = React.useState([])
      const [error, setError] = React.useState('')
      const [notice, setNotice] = React.useState('')
      const [busy, setBusy] = React.useState(false)

      // render options
      const [mode, setMode] = React.useState('three')
      const [layout, setLayout] = React.useState('sheet')
      const [yaw, setYaw] = React.useState(0)
      const [pitch, setPitch] = React.useState(0)
      const [views, setViews] = React.useState(['front', 'left', 'back'])
      const [notes, setNotes] = React.useState('')
      const [seed, setSeed] = React.useState('')
      const [count, setCount] = React.useState(1)
      const [photoAssetId, setPhotoAssetId] = React.useState(null)
      /** Output geometry. Adopted from the saved config on the first status read. */
      const [resolution, setResolution] = React.useState({ aspect: 'portrait', edge: 1024 })

      const [selected, setSelected] = React.useState(null)
      const [lightbox, setLightbox] = React.useState(null)
      const [newName, setNewName] = React.useState('')
      const [renaming, setRenaming] = React.useState('')
      const [lastPlan, setLastPlan] = React.useState(null)
      const [trash, setTrash] = React.useState(null)
      /**
       * Height of the task list, in pixels.
       *
       * A render is minutes long and several can be queued behind each other, so the list is
       * worth as much screen as the user wants to give it — and no more, which is why it
       * scrolls instead of growing without bound.
       */
      const [taskHeight, setTaskHeight] = React.useState(220)
      /**
       * Height of the gallery, in pixels.
       *
       * Same reason as the task list, and one more: the gallery sits BELOW the preview, so
       * an unbounded one grows upward in effect — every new render pushed the picture being
       * judged further out of sight.
       */
      const [libraryHeight, setLibraryHeight] = React.useState(260)
      /**
       * Whether the gallery keeps fitting itself to one row.
       *
       * Default true, because a fitted gallery is what people want and a fixed pixel height is
       * wrong the moment the window changes width. Dragging the handle sets it false — that is
       * an explicit choice — and the "一行高" button turns it back on.
       */
      const [libraryAutoFit, setLibraryAutoFit] = React.useState(true)
      /** The last upscale request, for the "what will be produced" line under the buttons. */
      const [lastUpscale, setLastUpscale] = React.useState(null)
      /** Whether the persisted height has been read yet. See `loadStatus`. */
      const heightAdopted = React.useRef(false)
      /** Same one-shot rule for the output resolution: a later refresh must not stomp an edit. */
      const resolutionAdopted = React.useRef(false)

      const activeRuns = runs.filter((r) => r.status === 'running')
      const busyRun = activeRuns[0] ?? null

      // ---------------------------------------------------------------- loading

      const loadStatus = React.useCallback(async (fresh) => {
        try {
          const payload = await api.status(fresh === true)
          setStatus(payload.status)
          if (payload.status?.config?.ui) {
            setLayout((current) => (current === 'sheet' ? payload.status.config.ui.sheetLayout ?? current : current))
            // Applied once, from the first status. A later refresh must not yank the panel
            // back to a remembered height while the user is in the middle of dragging it —
            // and `loadStatus` is called again by "刷新" and after every settings save.
            if (!heightAdopted.current) {
              heightAdopted.current = true
            const savedHeight = Number(payload.status.config.ui.taskPanelHeight)
            if (Number.isFinite(savedHeight) && savedHeight > 0) {
              setTaskHeight(Math.max(120, Math.min(720, Math.round(savedHeight))))
            }
            const savedLibrary = Number(payload.status.config.ui.libraryPanelHeight)
            if (Number.isFinite(savedLibrary) && savedLibrary > 0) {
              setLibraryHeight(Math.max(120, Math.min(720, Math.round(savedLibrary))))
            }
            if (payload.status.config.ui.libraryAutoFit === false) setLibraryAutoFit(false)
            }
            const savedResolution = payload.status.config.comfy?.resolution
            if (savedResolution?.aspect && !resolutionAdopted.current) {
              resolutionAdopted.current = true
              setResolution({
                aspect: savedResolution.aspect,
                edge: Number(savedResolution.edge) > 0 ? Number(savedResolution.edge) : 1024,
              })
            }
          }
        } catch (e) { setError(String(e.message ?? e)) }
      }, [])

      const loadCharacters = React.useCallback(async () => {
        try {
          const payload = await api.listCharacters()
          setCharacters(payload.characters ?? [])
          return payload.characters ?? []
        } catch (e) { setError(String(e.message ?? e)); return [] }
      }, [])

      const loadCharacter = React.useCallback(async (id) => {
        if (!id) { setCharacter(null); return null }
        try {
          const payload = await api.getCharacter(id)
          setCharacter(payload.character ?? null)
          return payload.character ?? null
        } catch (e) { setError(String(e.message ?? e)); return null }
      }, [])

      /** Live drag: local state only, so a pointer move never costs a request. */
      const applyTaskHeight = React.useCallback((next) => {
        setTaskHeight(Math.max(120, Math.min(720, Math.round(next))))
      }, [])

      /**
       * Persisted on pointer-up rather than during the drag.
       *
       * The config is a file on disk; writing it on every pointermove would mean dozens of
       * writes per drag for a value only the end of the drag decides.
       */
      const persistTaskHeight = React.useCallback((next) => {
        const height = Math.max(120, Math.min(720, Math.round(next)))
        setTaskHeight(height)
        api.saveConfig({ ui: { taskPanelHeight: height } }).catch(() => {
          // A height that failed to persist is not worth an error banner: it still applies
          // for this session, and the next drag will try again.
        })
      }, [])

      const applyLibraryHeight = React.useCallback((next) => {
        setLibraryHeight(Math.max(120, Math.min(720, Math.round(next))))
      }, [])

      const persistLibraryHeight = React.useCallback((next) => {
        const height = Math.max(120, Math.min(720, Math.round(next)))
        setLibraryHeight(height)
        api.saveConfig({ ui: { libraryPanelHeight: height } }).catch(() => { /* same as above */ })
      }, [])

      /**
       * Called when the user drags the gallery handle: an explicit height, so auto-fit is off.
       * It is not called by the fit measurement itself, which must not disable the mode that
       * produced it.
       */
      const setLibraryHeightManual = React.useCallback((next) => {
        setLibraryAutoFit(false)
        persistLibraryHeight(next)
        api.saveConfig({ ui: { libraryAutoFit: false } }).catch(() => { /* same as above */ })
      }, [persistLibraryHeight])

      const loadRuns = React.useCallback(async () => {
        try {
          const payload = await api.runs()
          setRuns(payload.runs ?? [])
        } catch { /* the run list is advisory; a failure must not blank the panel */ }
      }, [])

      const loadTrash = React.useCallback(async () => {
        try {
          const payload = await api.listTrash()
          setTrash({ entries: payload.entries ?? [], totalBytes: payload.totalBytes ?? 0, dir: payload.dir ?? null })
        } catch { /* the bin is advisory too */ }
      }, [])

      React.useEffect(() => {
        let cancelled = false
        ;(async () => {
          await loadStatus(false)
          const list = await loadCharacters()
          if (cancelled) return
          const remembered = list.find((c) => c.id === globalThis.__CHARACTERVIEWS__?.lastId)?.id
          const first = remembered ?? list[0]?.id ?? null
          setActiveId((current) => current ?? first)
          await loadRuns()
          await loadTrash()
        })()
        return () => { cancelled = true }
      }, [loadStatus, loadCharacters, loadRuns, loadTrash])

      React.useEffect(() => {
        if (!activeId) { setCharacter(null); return }
        loadCharacter(activeId)
        setSelected(null)
        setPhotoAssetId(null)
      }, [activeId, loadCharacter])

      // Poll while anything is running. 1.5s is well under a sampling step and costs one
      // loopback request, so there is no reason to be cleverer than this.
      //
      // The dependency is the BOOLEAN, not `runs`: keying the effect on the array would
      // tear down and rebuild the interval on every single poll result, and an interval
      // that is recreated every 1.5s never fires.
      const anyRunning = activeRuns.length > 0
      React.useEffect(() => {
        if (!anyRunning) return undefined
        let cancelled = false
        const timer = setInterval(() => { if (!cancelled) loadRuns() }, 1500)
        return () => { cancelled = true; clearInterval(timer) }
      }, [anyRunning, loadRuns])

      // A finished run is what produces the pictures, so the library is re-read once when
      // the last running job drops out. Same reason for the boolean dependency.
      React.useEffect(() => {
        if (!anyRunning) return
        return () => {
          ;(async () => {
            await loadCharacter(activeId)
            await loadCharacters()
          })()
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [anyRunning])

      React.useEffect(() => { if (notice) setError('') }, [notice])
      React.useEffect(() => { if (error) setNotice('') }, [error])

      async function guard(work) {
        setBusy(true)
        try {
          await work()
        } catch (e) {
          setError(String(e?.message ?? e))
        } finally {
          setBusy(false)
        }
      }

      // ---------------------------------------------------------------- actions

      async function createCharacter() {
        const name = newName.trim()
        if (!name) { setError('先给角色起个名字'); return }
        await guard(async () => {
          const payload = await api.createCharacter({ name })
          setNewName('')
          await loadCharacters()
          setActiveId(payload.character.id)
          setNotice(`已创建「${payload.character.name}」，目录：${payload.character.dir}`)
        })
      }

      async function renameCharacter() {
        const name = renaming.trim()
        if (!name || !character) return
        await guard(async () => {
          await api.updateCharacter(character.id, { name })
          setRenaming('')
          await loadCharacters()
          await loadCharacter(character.id)
          setNotice('已改名（文件夹也跟着改名了）')
        })
      }

      async function deleteCharacter(target) {
        const who = target ?? character
        if (!who) return
        if (!globalThis.confirm?.(`删除「${who.name}」？\n\n`
          + '它生成的那些图会直接删掉（ComfyUI 的 output 目录里还有一份）。\n'
          + '你上传的照片会移到插件的回收站，可以从「设置 → 回收站」恢复。')) return
        await guard(async () => {
          await api.removeCharacter(who.id)
          const list = await loadCharacters()
          setActiveId(list[0]?.id ?? null)
        })
      }

      async function uploadFiles(files) {
        const list = Array.from(files ?? []).filter((f) => String(f.type).startsWith('image/'))
        if (list.length === 0) { setError('请选择图片文件（png / jpg / webp）'); return }
        if (!character) { setError('先选一个角色，或者新建一个'); return }
        await guard(async () => {
          let last = null
          for (const file of list) {
            const dataUrl = await readFileAsDataUrl(file)
            const payload = await api.uploadPhoto(character.id, { dataUrl, filename: file.name })
            if (!payload.ok) throw new Error(payload.error?.message ?? '上传失败')
            last = payload
          }
          await loadCharacter(character.id)
          await loadCharacters()
          if (last?.asset) setPhotoAssetId(last.asset.id)
          setNotice(last?.warning ?? `已上传 ${list.length} 张照片`)
        })
      }

      async function startRender() {
        if (!character) { setError('先选一个角色'); return }
        if (photos.length === 0) { setError('先上传一张照片'); return }
        await guard(async () => {
          const payload = await api.render(character.id, {
            mode,
            layout,
            yaw,
            pitch,
            views,
            notes,
            count,
            aspect: resolution.aspect,
            edge: shownEdge,
            seed: seed.trim() === '' ? undefined : Number(seed),
            photoAssetId: photoAssetId ?? undefined,
          })
          if (!payload.ok) throw new Error(payload.error?.message ?? '无法开始出图')
          setLastPlan(payload.plan)
          await loadRuns()
          setNotice(`已开始出图（${payload.plan.jobs} 个任务，共 ${payload.plan.viewLabels.length} 个角度）。ComfyUI 出图通常 1–3 分钟一张。`)
        })
      }

      async function cancelRun(runId) {
        await guard(async () => {
          await api.cancelRun(runId)
          await loadRuns()
          setNotice('已取消，并从 ComfyUI 队列里撤掉了。')
        })
      }

      async function reveal(assetId) {
        await guard(async () => {
          const payload = await api.reveal(character?.id, assetId)
          if (!payload.ok) throw new Error(payload.error?.message ?? '打不开文件夹')
        })
      }

      /**
       * Upscale one rendered view.
       *
       * The result is a NEW asset rather than a replacement, and that is the point: the original
       * is the record of what the model actually produced, and overwriting it would make the
       * seed-and-prompt history a lie. The gallery shows both, labelled with the factor.
       */
      async function upscaleAsset(assetId, factor) {
        await guard(async () => {
          const payload = await api.upscale(character.id, { assetId, factor })
          if (!payload.ok) throw new Error(payload.error?.message ?? '无法开始放大')
          setLastUpscale(payload.plan)
          await loadRuns()
          setNotice(payload.plan.clamped
            ? `已开始放大，但 ${payload.plan.reason}`
            : `已开始放大到 ${payload.plan.factor}×（${payload.plan.width}×${payload.plan.height}），用 ${payload.plan.model}`)
        })
      }

      async function exportAsset(assetId, dir) {
        await guard(async () => {
          const payload = await api.exportAsset(character.id, { assetId, dir: dir ?? null })
          if (!payload.ok) throw new Error(payload.error?.message ?? '保存失败')
          setNotice(payload.saved ? `已另存到 ${payload.saved}` : '已在文件管理器里选中这个文件')
        })
      }

      async function removeAsset(assetId) {
        // The two kinds of file are deleted differently, so the confirmation says which
        // one this is instead of using one vague sentence for both. A photo is the only
        // thing here that cannot be produced again.
        const asset = (character?.assets ?? []).find((a) => a.id === assetId)
        const isPhoto = asset?.kind === 'photo'
        const message = isPhoto
          ? `删除照片「${asset?.label ?? ''}」？\n\n`
            + '照片会移到插件的回收站（设置里可以恢复），不会真的从磁盘上消失。\n'
            + '回收站里再删一次才会彻底删掉。'
          : '删除这张生成的图？\n\n'
            + '磁盘上的归档副本会被删掉；ComfyUI 自己的 output 目录里那一份不受影响，'
            + '而且用同样的种子和提示词可以重新生成。'
        if (!globalThis.confirm?.(message)) return
        await guard(async () => {
          const result = await api.removeAsset(character.id, assetId)
          if (selected?.id === assetId) setSelected(null)
          await loadCharacter(character.id)
          await loadCharacters()
          await loadTrash()
          if (result?.leftOnDisk) {
            setNotice(`项目已移除，但文件没能移进回收站，它仍在磁盘上：${result.leftOnDisk}`)
          } else if (isPhoto) {
            setNotice('照片已移到回收站，需要的话可以在「设置 → 回收站」里恢复。')
          } else {
            setNotice('已删除归档副本。ComfyUI 的 output 目录里还有一份。')
          }
        })
      }

      async function restoreTrashEntry(entryId) {
        await guard(async () => {
          const result = await api.restoreTrash(entryId)
          if (!result.ok) throw new Error(result.error?.message ?? '恢复失败')
          await loadCharacters()
          await loadTrash()
          setNotice('已恢复。它会重新出现在原来那个角色下。')
        })
      }

      async function purgeTrashEntry(entryId) {
        if (!globalThis.confirm?.('从回收站彻底删除？这一步之后文件真的没了。')) return
        await guard(async () => {
          await api.deleteTrashEntry(entryId)
          await loadTrash()
          setNotice('已彻底删除。')
        })
      }

      async function emptyTrash() {
        if (!globalThis.confirm?.('清空回收站？里面的照片会被彻底删除，无法恢复。')) return
        await guard(async () => {
          const result = await api.emptyTrash()
          await loadTrash()
          setNotice(`回收站已清空，释放了 ${formatBytes(result.freedBytes ?? 0)}。`)
        })
      }

      async function revealTrash() {
        await guard(async () => {
          // No path crosses the wire here: the host resolves its own trash directory, the
          // same way it resolves a character's folder. A route that opened an arbitrary
          // path would be a way to launch a file manager anywhere on the machine.
          const payload = await api.reveal('', null, 'trash')
          if (payload && payload.ok === false) throw new Error(payload.error?.message ?? '打不开文件夹')
        })
      }

      // ------------------------------------------------------------------ data

      const photos = (character?.assets ?? []).filter((a) => a.kind === 'photo')
      const generated = (character?.assets ?? []).filter((a) => a.kind === 'view')
      const activePhoto = photos.find((p) => p.id === photoAssetId) ?? photos[photos.length - 1] ?? null
      const comfy = status?.comfy ?? {}
      const capacity = status?.capacity ?? null
      const canRender = Boolean(character) && photos.length > 0 && status?.ok !== false

      const modeViews = mode === 'single'
        ? [{ label: describeAngle(yaw, pitch) }]
        : mode === 'custom'
          ? views.map((k) => ({ label: CUSTOM_VIEWS.find((v) => v.key === k)?.label ?? k }))
          : mode === 'multi'
            ? [{ label: '正面' }, { label: '左侧' }, { label: '背面' }, { label: '仰视 45°' }, { label: '俯视 45°' }]
            : [{ label: '正面' }, { label: '左侧' }, { label: '背面' }]
      const effectiveLayout = modeViews.length === 1 ? 'separate' : layout
      const estimatePerImage = { draft: 15, standard: 45, quality: 80 }[comfy.models ? status?.config?.comfy?.preset : 'standard'] ?? 45
      const estimateSeconds = (effectiveLayout === 'sheet' ? 1 : modeViews.length) * count * estimatePerImage

      // Output geometry, recomputed on every render so the number beside the controls is
      // always the number that will be sent.
      //
      // Only the lengths that FIT under the current ratio and view count are offered. A
      // dropdown that silently produces a smaller picture than the option says is worse than
      // one that does not offer the option: the user cannot tell which entry lied, and an
      // "adjusted" warning on most choices trains people to ignore warnings.
      const aspectList = ASPECTS
      const edgeList = EDGES.filter((edge) => !canvasFor(resolution.aspect, edge, effectiveLayout, modeViews.length).adjusted)
      const edgeChoices = edgeList.length > 0 ? edgeList : EDGES.slice(0, 1)

      // The select shows a fallback when the stored length is no longer offered (the ratio
      // was switched after picking one). Writing it back here — during render, not in an
      // effect — is what keeps what the user SEES and what gets SENT the same value, with no
      // frame in between where they disagree.
      const shownEdge = edgeChoices.includes(resolution.edge) ? resolution.edge : edgeChoices[edgeChoices.length - 1]
      const canvasPreview = canvasFor(resolution.aspect, shownEdge, effectiveLayout, modeViews.length)

      // --------------------------------------------------------------- render

      return h('div', { className: 'cv-root' },
        h('div', { className: 'cv-head' },
          h('div', { className: 'cv-title' }, '角色多视图'),
          h('span', { className: `cv-badge`, 'data-tone': status?.ok ? 'ok' : 'err' },
            status ? (status.ok ? `ComfyUI 已连接 · ${comfy.version ?? '?'}` : 'ComfyUI 有问题') : '检测中…'),
          capacity?.vramFreeBytes
            ? h('span', { className: 'cv-badge', 'data-tone': capacity.level === 'ok' ? 'ok' : capacity.level === 'tight' ? 'warn' : 'err' },
              `显存 ${formatBytes(capacity.vramFreeBytes)} 可用`)
            : null,
          h('button', {
            className: 'cv-btn', 'data-size': 'sm', disabled: busy,
            onClick: () => guard(async () => { await loadStatus(true); await loadCharacters() }),
          }, '刷新'),
          h('button', { className: 'cv-btn', 'data-size': 'sm', onClick: () => reveal(null) }, '打开图片目录')),

        error ? h('div', { className: 'cv-card', style: { margin: '10px 14px 0', borderColor: 'var(--cv-err)' } },
          h('div', { className: 'cv-err' }, error)) : null,
        notice ? h('div', { className: 'cv-card', style: { margin: '10px 14px 0' } },
          h('div', { className: 'cv-ok' }, notice)) : null,
        (status?.problems ?? []).length > 0
          ? h('div', { className: 'cv-card', style: { margin: '10px 14px 0' } },
            h('h3', null, '环境检查'),
            ...(status.problems).map((p, i) => h('div', { key: i, className: 'cv-warn' }, `· ${p}`)),
            h('p', { className: 'cv-hint' }, '这些只影响出图；下面的设置里可以改 ComfyUI 地址和手动指定模型。'))
          : null,

        h('div', { className: 'cv-split' },
          // ------------------------------------------------------------ left
          h('div', { className: 'cv-left' },
            h('div', { className: 'cv-card' },
              h('h3', null, '角色', h('span', { className: 'cv-grow' }),
                character ? h('button', {
                  className: 'cv-btn', 'data-size': 'sm',
                  onClick: () => setRenaming(character.name),
                }, '改名') : null,
                character ? h('button', {
                  className: 'cv-btn', 'data-size': 'sm', 'data-tone': 'danger',
                  onClick: () => deleteCharacter(character),
                }, '删除') : null),
              h('div', { className: 'cv-row' },
                h('div', { className: 'cv-field' },
                  h('label', null, '当前角色'),
                  h('select', {
                    className: 'cv-select', value: activeId ?? '',
                    onChange: (e) => setActiveId(e.target.value || null),
                  },
                    h('option', { value: '' }, '（未选择）'),
                    ...characters.map((c) => h('option', { key: c.id, value: c.id },
                      `${c.name}（照片 ${c.photoCount} · 出图 ${c.viewCount}）`))))),
              renaming ? h('div', { className: 'cv-row', style: { marginTop: 8 } },
                h('div', { className: 'cv-field' }, h('label', null, '新名字'), h('input', {
                  className: 'cv-input', value: renaming, onChange: (e) => setRenaming(e.target.value),
                  onKeyDown: (e) => { if (e.key === 'Enter') renameCharacter() },
                })),
                h('button', { className: 'cv-btn', 'data-variant': 'primary', disabled: busy, onClick: renameCharacter }, '保存'),
                h('button', { className: 'cv-btn', onClick: () => setRenaming('') }, '取消')) : null,
              h('div', { className: 'cv-row', style: { marginTop: 8 } },
                h('div', { className: 'cv-field' }, h('label', null, '新建角色'),
                  h('input', {
                    className: 'cv-input', placeholder: '例如：女主 小满', value: newName,
                    onChange: (e) => setNewName(e.target.value),
                    onKeyDown: (e) => { if (e.key === 'Enter') createCharacter() },
                  })),
                h('button', { className: 'cv-btn', disabled: busy || !newName.trim(), onClick: createCharacter }, '新建')),
              character ? h('p', { className: 'cv-hint', style: { marginTop: 8 } },
                h('span', { className: 'cv-monospace' }, character.dir)) : null),

            h('div', { className: 'cv-card' },
              h('h3', null, '① 照片', h('span', { className: 'cv-grow' }),
                h('span', { className: 'cv-badge' }, `${photos.length} 张`)),
              h('div', {
                className: 'cv-drop',
                onDragOver: (e) => { e.preventDefault(); e.currentTarget.dataset.over = '1' },
                onDragLeave: (e) => { e.currentTarget.dataset.over = '0' },
                onDrop: (e) => {
                  e.preventDefault()
                  e.currentTarget.dataset.over = '0'
                  uploadFiles(e.dataTransfer?.files)
                },
                onClick: () => {
                  if (!character) { setError('先选一个角色，或者新建一个'); return }
                  const input = document.createElement('input')
                  input.type = 'file'
                  input.accept = 'image/*'
                  input.multiple = true
                  input.onchange = () => uploadFiles(input.files)
                  input.click()
                },
              },
                h('div', null, '把人物照片拖进来，或点击选择'),
                h('div', { style: { fontSize: 11, marginTop: 2 } }, '正面、清晰、全身最好；一张就够，多张会一起作为参考')),
              photos.length > 0
                ? h('div', { className: 'cv-thumbs' },
                  ...photos.map((photo) => h('div', { key: photo.id, style: { position: 'relative' } },
                    h('button', {
                      className: 'cv-thumb', 'data-on': activePhoto?.id === photo.id ? '1' : '0',
                      title: `${photo.label}　点击选为出图依据`,
                      onClick: () => setPhotoAssetId(photo.id),
                    }, h('img', { src: api.assetUrl(character.id, photo.id), alt: photo.label })),
                    h('button', {
                      className: 'cv-thumb-x', title: '删除这张照片',
                      onClick: (e) => { e.stopPropagation(); removeAsset(photo.id) },
                    }, '×'))))
                : null,
              activePhoto ? h('p', { className: 'cv-hint' },
                `出图依据：${activePhoto.label}（${formatBytes(activePhoto.bytes)}）`) : null),

            h('div', { className: 'cv-card' },
              h('h3', null, '② 视图模式'),
              h('div', { className: 'cv-modes' },
                ...[
                  { key: 'single', label: '单视图', sub: '一个角度' },
                  { key: 'three', label: '三视图', sub: '正/侧/背' },
                  { key: 'multi', label: '多视图', sub: '五角度' },
                  { key: 'custom', label: '任意角度', sub: '自由组合' },
                ].map((m) => h('button', {
                  key: m.key, className: 'cv-mode', 'data-on': mode === m.key ? '1' : '0',
                  onClick: () => setMode(m.key),
                }, m.label, h('small', null, m.sub)))),

              mode === 'single' ? h('div', { style: { marginTop: 10 } },
                h('div', { className: 'cv-chips' },
                  ...ANGLES.map((a) => h('button', {
                    key: `${a.yaw}-${a.pitch}`, className: 'cv-chip',
                    'data-on': Number(yaw) === a.yaw && Number(pitch) === a.pitch ? '1' : '0',
                    onClick: () => { setYaw(a.yaw); setPitch(a.pitch) },
                  }, a.label))),
                h('div', { style: { marginTop: 8 } },
                  h('label', { className: 'cv-field' },
                    h('span', { style: { fontSize: 11, color: 'var(--cv-muted)', fontWeight: 600 } },
                      `水平角 ${Math.round(yaw)}°　（0 正面 · 90 右侧 · 180 背面 · 270 左侧）`),
                    h('input', {
                      className: 'cv-slider', type: 'range', min: 0, max: 359, step: 1,
                      value: yaw, onChange: (e) => setYaw(Number(e.target.value)),
                    }))),
                h('div', { style: { marginTop: 6 } },
                  h('label', { className: 'cv-field' },
                    h('span', { style: { fontSize: 11, color: 'var(--cv-muted)', fontWeight: 600 } },
                      `俯仰角 ${Math.round(pitch)}°　（正数俯视 · 负数仰视）`),
                    h('input', {
                      className: 'cv-slider', type: 'range', min: -60, max: 60, step: 5,
                      value: pitch, onChange: (e) => setPitch(Number(e.target.value)),
                    }))),
                h('p', { className: 'cv-hint' }, `当前：${describeAngle(yaw, pitch)}`)) : null,

              mode === 'custom' ? h('div', { style: { marginTop: 10 } },
                h('div', { className: 'cv-chips' },
                  ...CUSTOM_VIEWS.map((v) => h('button', {
                    key: v.key, className: 'cv-chip', 'data-on': views.includes(v.key) ? '1' : '0',
                    onClick: () => setViews((current) => current.includes(v.key)
                      ? current.filter((k) => k !== v.key)
                      : [...current, v.key].slice(0, 8)),
                  }, v.label))),
                h('p', { className: 'cv-hint' }, `已选 ${views.length} 个角度（最多 8 个），按点选顺序排列。`)) : null,

              modeViews.length > 1 ? h('div', { style: { marginTop: 10 } },
                h('div', { className: 'cv-chips' },
                  h('button', {
                    className: 'cv-chip', 'data-on': layout === 'sheet' ? '1' : '0',
                    onClick: () => setLayout('sheet'),
                  }, '一张设定图'),
                  h('button', {
                    className: 'cv-chip', 'data-on': layout === 'separate' ? '1' : '0',
                    onClick: () => setLayout('separate'),
                  }, '每角度一张')),
                h('p', { className: 'cv-hint' }, layout === 'sheet'
                  ? '所有角度画在同一张图里：比例、光照、服装最统一，适合当建模参考。'
                  : '每个角度单独出一张：分辨率更高，某一张不满意可以单独重抽。')) : null),

            h('div', { className: 'cv-card' },
              h('h3', null, '③ 出图', h('span', { className: 'cv-grow' }),
                h('span', { className: 'cv-badge' }, `${canvasPreview.width}×${canvasPreview.height}`)),

              // Resolution sits at the top of the render card, above the things that change
              // between attempts: the size of the output is usually decided once and then
              // left alone, while the seed changes every time.
              h('div', { className: 'cv-field' },
                h('label', null, '分辨率　比例'),
                h('div', { className: 'cv-chips' },
                  ...aspectList.map((aspect) => h('button', {
                    key: aspect.key,
                    className: 'cv-chip',
                    'data-on': resolution.aspect === aspect.key ? '1' : '0',
                    onClick: () => setResolution((current) => ({ ...current, aspect: aspect.key })),
                  }, aspect.label)))),
              h('div', { className: 'cv-row tight', style: { marginTop: 6 } },
                h('div', { className: 'cv-field', style: { maxWidth: 150 } },
                  h('label', null, '长边像素'),
                  h('select', {
                    className: 'cv-select', value: shownEdge,
                    onChange: (e) => setResolution((current) => ({ ...current, edge: Number(e.target.value) })),
                  }, ...edgeChoices.map((edge) => h('option', { key: edge, value: edge },
                    `${edge} px`)))),
                h('div', { className: 'cv-field' },
                  h('label', null, '每个视图'),
                  h('input', {
                    className: 'cv-input', readOnly: true,
                    value: `${canvasPreview.view.width}×${canvasPreview.view.height}`,
                  }))),
              // Reachable by switching ratio after picking a length: the old length is no
              // longer offered, so the select falls back — and the fallback has to be
              // written back into the state, or the render would use a stale value.
              !edgeChoices.includes(resolution.edge)
                ? h('p', { className: 'cv-warn' },
                  `这个比例下 ${resolution.edge}px 放不下（会超过上限），已改用 ${edgeChoices[edgeChoices.length - 1]}px。`)
                : null,
              h('p', { className: 'cv-hint' },
                effectiveLayout === 'sheet' && modeViews.length > 1
                  ? `每个视图 ${canvasPreview.view.width}×${canvasPreview.view.height}，`
                    + `${canvasPreview.columns}×${canvasPreview.rows} 排布，整张画布 ${canvasPreview.width}×${canvasPreview.height}（${canvasPreview.megapixels} MP）。`
                    + ' 分辨率指的是**每个视图**的尺寸。'
                  : `输出 ${canvasPreview.width}×${canvasPreview.height}（${canvasPreview.megapixels} MP）。`),
              canvasPreview.adjusted
                ? h('p', { className: 'cv-warn' }, `注意：${canvasPreview.reason}。想要更大就得减少角度数量，或改用「每角度一张」。`)
                : null,

              h('div', { className: 'cv-row tight', style: { marginTop: 8 } },
                h('div', { className: 'cv-field', style: { maxWidth: 100 } },
                  h('label', null, '变体数量'),
                  h('select', {
                    className: 'cv-select', value: count, onChange: (e) => setCount(Number(e.target.value)),
                  }, ...[1, 2, 3, 4].map((n) => h('option', { key: n, value: n }, `${n} 张`)))),
                h('div', { className: 'cv-field' },
                  h('label', null, '种子（留空随机）'),
                  h('input', {
                    className: 'cv-input', value: seed, placeholder: '例如 12345',
                    onChange: (e) => setSeed(e.target.value.replace(/[^0-9]/g, '')),
                  }))),
              h('div', { style: { marginTop: 8 } },
                h('label', { className: 'cv-field' },
                  h('span', { style: { fontSize: 11, color: 'var(--cv-muted)', fontWeight: 600 } }, '补充要求（可选）'),
                  h('textarea', {
                    className: 'cv-textarea', value: notes, placeholder: '例如：保持这件深灰色圆领 T 恤；不要背包；背景换成纯白',
                    onChange: (e) => setNotes(e.target.value),
                  }))),
              h('p', { className: 'cv-hint' },
                `将出 ${effectiveLayout === 'sheet' ? 1 : modeViews.length} 个任务 × ${count} 张，`
                + `${status?.config?.comfy?.preset ?? 'standard'} 预设。`
                + ` 大致需要 ${Math.round(estimateSeconds / 60 * 10) / 10} 分钟（显存紧张时会更久）。`),
              h('div', { className: 'cv-row', style: { marginTop: 8 } },
                h('button', {
                  className: 'cv-btn', 'data-variant': 'primary', disabled: busy || !canRender,
                  onClick: startRender,
                }, busyRun ? '正在出图…' : '开始出图'),
                busyRun ? h('button', { className: 'cv-btn', 'data-tone': 'danger', onClick: () => cancelRun(busyRun.id) }, '取消') : null),
              !character ? h('p', { className: 'cv-hint' }, '先选或新建一个角色。')
                : photos.length === 0 ? h('p', { className: 'cv-hint' }, '先上传一张照片。') : null),

            h('div', { className: 'cv-card', style: { display: 'flex', flexDirection: 'column', minHeight: 0 } },
              h('h3', null, '任务',
                h('span', { className: 'cv-grow' }),
                runs.length > 0 ? h('span', { className: 'cv-badge' }, `${runs.filter((r) => r.status === 'running').length} 进行中 / ${runs.length}`) : null),
              h(ResizablePanel, {
                height: taskHeight,
                defaultHeight: 220,
                label: '任务列表',
                onResize: applyTaskHeight,
                onResizeEnd: persistTaskHeight,
                footerLeft: `${runs.length} 条记录　高度 ${taskHeight}px`,
                empty: runs.length === 0
                  ? h('p', { className: 'cv-hint', style: { margin: 0 } }, '出图时这里会显示进度。')
                  : null,
              },
                // Newest first, and capped: the panel scrolls, so a hundred finished runs
                // would only cost render time for rows nobody is looking at.
                runs.length === 0 ? null : runs.slice(0, 20).map((run) => h(RunRow, {
                  key: run.id, run, onCancel: cancelRun,
                })))),

            h('details', { className: 'cv-card' },
              h('summary', { style: { cursor: 'pointer', fontWeight: 600 } },
                '设置',
                trash?.entries?.length
                  ? h('span', { className: 'cv-badge', style: { marginLeft: 8 } }, `回收站 ${trash.entries.length}`)
                  : null),
              h(Settings, { status, onSaved: async () => { await loadStatus(true); await loadCharacters() }, setNotice, setError }),
              h(RecycleBin, {
                trash,
                onRestore: restoreTrashEntry,
                onPurge: purgeTrashEntry,
                onEmpty: emptyTrash,
                onReveal: revealTrash,
                characterId: character?.id,
                busy,
              }))),

          // ----------------------------------------------------------- right
          h('div', { className: 'cv-right' },
            h('div', { className: 'cv-stage' },
              selected
                ? h('img', {
                  className: 'cv-stage-img', src: api.assetUrl(character.id, selected.id), alt: selected.label,
                  onClick: () => setLightbox(selected),
                })
                : h('div', { className: 'cv-empty' },
                  h('b', null, generated.length > 0 ? '选一张图看大图' : '还没有出图'),
                  h('span', null, generated.length > 0
                    ? '下面的图库里点任意一张，这里会放大显示。'
                    : '左边上传一张照片，选好角度，点「开始出图」。')),
              selected ? h('div', { className: 'cv-row tight' },
                h('span', { className: 'cv-badge' }, selected.label),
                h('span', { className: 'cv-badge' }, formatBytes(selected.bytes)),
                h('span', { className: 'cv-grow', style: { flex: '1 1 auto' } }),
                // "全屏", not "放大": HD upscaling is the thing that enlarges a PICTURE, and two
                // buttons doing "放大" while doing different things is a trap.
                h('button', { className: 'cv-btn', 'data-size': 'sm', onClick: () => setLightbox(selected) }, '全屏'),
                h('button', { className: 'cv-btn', 'data-size': 'sm', onClick: () => reveal(selected.id) }, '打开文件所在位置'),
                h('button', { className: 'cv-btn', 'data-size': 'sm', onClick: () => exportAsset(selected.id, null) }, '保存…'),
                h('button', { className: 'cv-btn', 'data-size': 'sm', 'data-tone': 'danger', onClick: () => removeAsset(selected.id) }, '删除')) : null,
              selected ? h(UpscaleBar, {
                asset: selected,
                upscale: status?.upscale ?? null,
                busy,
                onUpscale: (factor) => upscaleAsset(selected.id, factor),
                lastPlan: lastUpscale,
              }) : null,
              selected?.comfy?.filename
                ? h('div', { className: 'cv-monospace' }, `ComfyUI: ${selected.comfy.filename}`)
                : null),

            lastPlan ? h('details', { className: 'cv-card' },
              h('summary', { style: { cursor: 'pointer', fontWeight: 600 } },
                `这次实际发出去的提示词（${lastPlan.viewLabels.join(' / ')}）`),
              h('p', { className: 'cv-hint' }, `画布 ${lastPlan.canvas?.width}×${lastPlan.canvas?.height}，${lastPlan.steps} 步，种子 ${lastPlan.seed}，${lastPlan.layout === 'sheet' ? '一张设定图' : '每角度一张'}`),
              h('div', { style: { fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, lastPlan.positive),
              h('div', { className: 'cv-monospace', style: { marginTop: 6 } }, `负向：${lastPlan.negative}`)) : null,

            // ------------------------------------------------------------ gallery
            //
            // The panel measures itself to the height of ONE ROW of thumbnails instead of
            // using a guessed pixel value. The grid is `minmax(140px, 1fr)`, so how tall a
            // row is depends on how wide the panel currently is — a fixed number is either a
            // sliver of the row or a sliver of the next one, and it is wrong again the moment
            // the window is resized.
            h(GallerySection, {
              generated,
              character,
              selected,
              libraryHeight,
              autoFit: libraryAutoFit,
              // The fit measurement writes through the plain setter: it must not turn off the
              // mode that produced it. Only a drag goes through the manual setter.
              onFit: persistLibraryHeight,
              onResize: applyLibraryHeight,
              onResizeEnd: setLibraryHeightManual,
              onResetFit: () => {
                setLibraryAutoFit(true)
                api.saveConfig({ ui: { libraryAutoFit: true } }).catch(() => { /* best effort */ })
              },
              onSelect: setSelected,
              onOpen: setLightbox,
              onReveal: (item) => reveal(item.id),
              onRemove: (item) => removeAsset(item.id),
              onOpenLatest: () => setLightbox([...generated][generated.length - 1]),
            }),

            (character?.batches ?? []).length > 0 ? h('details', { className: 'cv-card' },
              h('summary', { style: { cursor: 'pointer', fontWeight: 600 } }, `出图记录（${character.batches.length} 批）`),
              ...character.batches.slice(0, 6).map((batch) => h('div', { key: batch.id, className: 'cv-run' },
                h('div', { className: 'cv-run-top' },
                  h('span', { className: 'cv-badge' }, batch.mode),
                  h('span', { className: 'cv-grow' }, batch.viewLabels.join(' / ')),
                  h('span', { style: { fontSize: 11, color: 'var(--cv-muted)' } }, new Date(batch.createdAt).toLocaleString())),
                h('dl', { className: 'cv-kv' },
                  h('dt', null, '种子'), h('dd', null, String(batch.seed)),
                  h('dt', null, '画布'), h('dd', null, `${batch.canvas?.width}×${batch.canvas?.height} · ${batch.steps} 步`),
                  h('dt', null, '产物'), h('dd', null, batch.assetIds.join(', ')))))) : null)),

        lightbox ? h(Lightbox, {
          asset: lightbox, characterId: character?.id,
          onClose: () => setLightbox(null),
          onReveal: () => reveal(lightbox.id),
          onSave: () => exportAsset(lightbox.id, null),
        }) : null)
    }

    /**
     * Full-screen preview.
     *
     * Rendered through a PORTAL into `document.body`, and that is the load-bearing detail.
     * Inside the panel, `position: fixed` is only fixed with respect to the nearest ancestor
     * that establishes a containing block — and the shell's scroll containers use transforms
     * and `overflow`, which do exactly that. The overlay was therefore being CLIPPED to the
     * panel while sizing itself from the whole window's `94vw`, so a wide picture was cut off
     * and a tall one floated in a box far smaller than the space it appeared to have.
     *
     * Sizing itself is `max-width/height: 100%` inside a padded flex container: the browser
     * resolves that against the actual viewport on every resize, which is what "follow the
     * canvas" needs and is more robust than measuring anything by hand.
     */
    function Lightbox(props) {
      const { asset, characterId, onClose, onReveal, onSave } = props
      const [zoom, setZoom] = React.useState(1)
      const [pan, setPan] = React.useState({ x: 0, y: 0 })

      // A new picture starts at fit-size and centred. Without this, opening a second image
      // after zooming into the first one showed it already zoomed and pushed off-centre.
      React.useEffect(() => { setZoom(1); setPan({ x: 0, y: 0 }) }, [asset?.id])

      React.useEffect(() => {
        const onKey = (event) => {
          if (event.key === 'Escape') onClose()
          if (event.key === '0') { setZoom(1); setPan({ x: 0, y: 0 }) }
        }
        globalThis.addEventListener?.('keydown', onKey)
        return () => globalThis.removeEventListener?.('keydown', onKey)
      }, [onClose])

      if (!asset) return null

      const zoomBy = (factor) => setZoom((current) => {
        const next = Math.max(1, Math.min(8, current * factor))
        if (next === 1) setPan({ x: 0, y: 0 })
        return next
      })

      function beginPan(event) {
        if (zoom <= 1) return
        event.preventDefault()
        const origin = { x: event.clientX, y: event.clientY }
        const from = { ...pan }
        const onMove = (moveEvent) => {
          setPan({ x: from.x + (moveEvent.clientX - origin.x), y: from.y + (moveEvent.clientY - origin.y) })
        }
        const onUp = () => {
          globalThis.removeEventListener?.('pointermove', onMove)
          globalThis.removeEventListener?.('pointerup', onUp)
        }
        globalThis.addEventListener?.('pointermove', onMove)
        globalThis.addEventListener?.('pointerup', onUp)
      }

      const overlay = h('div', {
        className: 'cv-lightbox',
        onPointerDown: (event) => { if (event.target === event.currentTarget) onClose() },
      },
        h('img', {
          className: 'cv-lightbox-img',
          src: api.assetUrl(characterId, asset.id),
          alt: asset.label,
          draggable: false,
          onPointerDown: beginPan,
          onWheel: (event) => { zoomBy(event.deltaY < 0 ? 1.2 : 1 / 1.2) },
          onDoubleClick: () => (zoom > 1 ? (setZoom(1), setPan({ x: 0, y: 0 })) : zoomBy(2)),
          style: {
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            cursor: zoom > 1 ? 'grab' : 'zoom-in',
            // Without this, a zoomed picture is still clamped by the fit-size box and simply
            // pans inside it instead of growing.
            maxWidth: zoom > 1 ? 'none' : '100%',
            maxHeight: zoom > 1 ? 'none' : '100%',
            width: zoom > 1 ? 'auto' : undefined,
          },
        }),
        h('div', { className: 'cv-lb-bar', onPointerDown: (event) => event.stopPropagation() },
          h('span', { className: 'cv-badge' }, asset.label),
          h('span', { className: 'cv-badge' }, `${zoom.toFixed(zoom < 2 ? 1 : 0)}×`),
          h('button', { className: 'cv-btn', onClick: () => zoomBy(1 / 1.5), disabled: zoom <= 1 }, '缩小'),
          h('button', { className: 'cv-btn', onClick: () => zoomBy(1.5) }, '放大'),
          h('button', { className: 'cv-btn', onClick: () => { setZoom(1); setPan({ x: 0, y: 0 }) } }, '适应'),
          h('button', { className: 'cv-btn', onClick: onReveal }, '打开文件所在位置'),
          h('button', { className: 'cv-btn', onClick: onSave }, '保存…'),
          h('button', { className: 'cv-btn', onClick: onClose }, '关闭（Esc）')),
        h('div', { className: 'cv-lb-hint' },
          zoom > 1 ? '滚轮缩放 · 拖动平移 · 双击复位 · Esc 关闭' : '滚轮或双击放大 · Esc 关闭'))

      // A portal needs a real document; the render tests have none, and falling back to an
      // inline render keeps them meaningful.
      if (typeof document === 'undefined' || !document.body) return overlay
      return createPortal(overlay, document.body)
    }

    /** Settings: the ComfyUI endpoint, the render budget, the models, the paths. */
    function Settings(props) {
      const { status, onSaved, setNotice, setError } = props
      const [draft, setDraft] = React.useState(null)
      const [baseUrl, setBaseUrl] = React.useState('')
      const [testing, setTesting] = React.useState(false)
      const [busy, setBusy] = React.useState(false)

      React.useEffect(() => {
        if (!status?.config || draft) return
        setDraft(status.config)
        setBaseUrl(status.config.comfy.baseUrl)
      }, [status, draft])

      if (!draft) return h('p', { className: 'cv-hint' }, '读取设置…')

      function patchComfy(patch) {
        setDraft((current) => ({ ...current, comfy: { ...current.comfy, ...patch } }))
      }
      function patchModels(patch) {
        setDraft((current) => ({ ...current, comfy: { ...current.comfy, models: { ...current.comfy.models, ...patch } } }))
      }

      async function save() {
        setBusy(true)
        try {
          await api.saveConfig({ comfy: draft.comfy, prompt: draft.prompt })
          setNotice('设置已保存。')
          await onSaved()
        } catch (e) { setError(String(e.message ?? e)) } finally { setBusy(false) }
      }

      async function test() {
        setTesting(true)
        try {
          const payload = await api.test(baseUrl)
          if (payload.ok) setNotice(`连上了：ComfyUI ${payload.health.version ?? '?'}，输出目录 ${payload.health.outputDir ?? '未知'}`)
          else setError(`连不上：${payload.error?.message ?? '未知原因'}`)
        } catch (e) { setError(String(e.message ?? e)) } finally { setTesting(false) }
      }

      const lists = status?.comfy?.modelLists ?? {}
      const picked = status?.comfy?.models ?? {}

      return h('div', null,
        h('div', { className: 'cv-row' },
          h('div', { className: 'cv-field' }, h('label', null, 'ComfyUI 地址'),
            h('input', { className: 'cv-input', value: baseUrl, onChange: (e) => setBaseUrl(e.target.value) })),
          h('button', { className: 'cv-btn', disabled: testing, onClick: test }, testing ? '测试中…' : '测试连接')),
        h('div', { style: { marginTop: 10 } },
          h('div', { style: { fontSize: 11, color: 'var(--cv-muted)', fontWeight: 600, marginBottom: 4 } },
            '默认分辨率（出图卡片里可以每次单独改）'),
          h('div', { className: 'cv-row tight' },
            h('div', { className: 'cv-field' }, h('label', null, '比例'),
              h('select', {
                className: 'cv-select', value: draft.comfy.resolution?.aspect ?? 'portrait',
                onChange: (e) => patchComfy({ resolution: { ...(draft.comfy.resolution ?? {}), aspect: e.target.value } }),
              }, ...ASPECTS.map((aspect) => h('option', { key: aspect.key, value: aspect.key }, aspect.label)))),
            h('div', { className: 'cv-field' }, h('label', null, '长边像素'),
              h('select', {
                className: 'cv-select', value: draft.comfy.resolution?.edge ?? 1024,
                onChange: (e) => patchComfy({ resolution: { ...(draft.comfy.resolution ?? {}), edge: Number(e.target.value) } }),
              }, ...EDGES.map((edge) => h('option', { key: edge, value: edge }, `${edge} px`)))),
            h('div', { className: 'cv-field' }, h('label', null, '预设'),
              h('select', {
                className: 'cv-select', value: draft.comfy.preset,
                onChange: (e) => patchComfy({ preset: e.target.value }),
              }, ...Object.entries(status?.presets ?? { standard: '标准' }).map(([key, label]) => h('option', { key, value: key }, label)))),
            h('div', { className: 'cv-field' }, h('label', null, '参考图尺寸'),
              h('input', {
                className: 'cv-input', type: 'number', min: 0, max: 4096, step: 32, value: draft.comfy.referenceResolution,
                onChange: (e) => patchComfy({ referenceResolution: Number(e.target.value) }),
              })))),

        h('div', { style: { marginTop: 10 } },
          h('label', { className: 'cv-field' }, h('span', { style: { fontSize: 11, color: 'var(--cv-muted)', fontWeight: 600 } },
            '图片另存目录（留空 = 用插件目录下的 characters/）'),
            h('input', {
              className: 'cv-input', value: draft.comfy.outputDir ?? '', placeholder: status?.paths?.characters ?? '',
              onChange: (e) => patchComfy({ outputDir: e.target.value || null }),
            }))),

        h('div', { style: { marginTop: 10 } },
          h('div', { style: { fontSize: 11, color: 'var(--cv-muted)', fontWeight: 600, marginBottom: 4 } }, '模型（留空 = 自动挑）'),
          ...[
            ['diffusionModel', '扩散模型'],
            ['textEncoder', '文本编码器'],
            ['vae', 'VAE'],
            ['lora', '加速 LoRA（仅草稿预设用）'],
          ].map(([key, label]) => h('div', { key, className: 'cv-row', style: { marginBottom: 4 } },
            h('div', { className: 'cv-field' }, h('label', null, label),
              h('select', {
                className: 'cv-select', value: draft.comfy.models[key] ?? '',
                onChange: (e) => patchModels({ [key]: e.target.value || null }),
              },
                h('option', { value: '' }, `自动（当前：${picked[key] ?? '未找到'}）`),
                ...(lists[key === 'diffusionModel' ? 'diffusionModel' : key] ?? []).map((name) => h('option', { key: name, value: name }, name))))))),

        h('div', { style: { marginTop: 10 } },
          h('div', { style: { fontSize: 11, color: 'var(--cv-muted)', fontWeight: 600, marginBottom: 4 } }, '提示词后缀'),
          h('label', { className: 'cv-field' }, h('span', { style: { fontSize: 11, color: 'var(--cv-muted)' } }, '背景描述'),
            h('input', {
              className: 'cv-input', value: draft.prompt.background,
              onChange: (e) => setDraft({ ...draft, prompt: { ...draft.prompt, background: e.target.value } }),
            })),
          h('label', { className: 'cv-field', style: { marginTop: 4 } }, h('span', { style: { fontSize: 11, color: 'var(--cv-muted)' } }, '画风后缀'),
            h('input', {
              className: 'cv-input', value: draft.prompt.styleSuffix,
              onChange: (e) => setDraft({ ...draft, prompt: { ...draft.prompt, styleSuffix: e.target.value } }),
            })),
          h('label', { className: 'cv-field', style: { marginTop: 4 } }, h('span', { style: { fontSize: 11, color: 'var(--cv-muted)' } }, '负向后缀'),
            h('input', {
              className: 'cv-input', value: draft.prompt.negativeSuffix,
              onChange: (e) => setDraft({ ...draft, prompt: { ...draft.prompt, negativeSuffix: e.target.value } }),
            }))),

        h('div', { className: 'cv-row', style: { marginTop: 10 } },
          h('button', { className: 'cv-btn', 'data-variant': 'primary', disabled: busy, onClick: save }, busy ? '保存中…' : '保存设置')),

        h('dl', { className: 'cv-kv', style: { marginTop: 10 } },
          h('dt', null, '插件目录'), h('dd', { className: 'cv-monospace' }, status?.paths?.pluginRoot),
          h('dt', null, '图片目录'), h('dd', { className: 'cv-monospace' }, status?.paths?.characters),
          h('dt', null, 'ComfyUI 输出'), h('dd', { className: 'cv-monospace' }, status?.paths?.comfyOutput ?? '未知'),
          h('dt', null, '已占用'), h('dd', null, formatBytes(status?.libraryBytes ?? 0))),
        h('p', { className: 'cv-hint' },
          'ComfyUI 那边也始终会留一份（它的 SaveImage 写在自己的 output 目录里），这里的目录是插件额外归档的一份。'))
    }

    /**
     * The recycle bin.
     *
     * It exists because the two kinds of file here are not alike: a generated view can be
     * produced again from its recorded seed and prompt, a photograph somebody supplied
     * cannot. Deleting a photo therefore moves it here rather than erasing it, and this is
     * where "I did not mean that" gets undone.
     */
    function RecycleBin(props) {
      const { trash, onRestore, onPurge, onEmpty, onReveal, busy } = props
      const entries = trash?.entries ?? []
      const total = trash?.totalBytes ?? 0

      return h('div', { className: 'cv-details' },
        h('div', { className: 'cv-row tight' },
          h('div', { style: { fontWeight: 600, flex: '1 1 auto' } },
            '回收站',
            h('span', { className: 'cv-badge', style: { marginLeft: 6 } },
              entries.length === 0 ? '空' : `${entries.length} 张 · ${formatBytes(total)}`)),
          entries.length > 0 ? h('button', {
            className: 'cv-btn', 'data-size': 'sm', disabled: busy, onClick: onReveal,
          }, '打开文件夹') : null,
          entries.length > 0 ? h('button', {
            className: 'cv-btn', 'data-size': 'sm', 'data-tone': 'danger', disabled: busy, onClick: onEmpty,
          }, '清空') : null),
        h('p', { className: 'cv-hint' },
          '你上传的照片不会直接被删掉，而是先放到这里——照片是唯一不能再生成的东西，'
          + '生成的图则是可重出的，所以那边是直接删。'),
        trash?.dir ? h('div', { className: 'cv-monospace', style: { marginTop: 4 } }, trash.dir) : null,

        entries.length === 0
          ? null
          : h('div', { style: { marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 } },
            ...entries.map((entry) => h('div', { key: entry.id, className: 'cv-run' },
              h('div', { className: 'cv-run-top' },
                h('span', { className: 'cv-grow', title: entry.originalName ?? '' },
                  entry.originalName ?? entry.fileName),
                h('span', { style: { fontSize: 11, color: 'var(--cv-muted)' } }, formatBytes(entry.size)),
                h('button', {
                  className: 'cv-btn', 'data-size': 'sm', disabled: busy,
                  onClick: () => onRestore(entry.id),
                }, '恢复'),
                h('button', {
                  className: 'cv-btn', 'data-size': 'sm', 'data-tone': 'danger', disabled: busy,
                  onClick: () => onPurge(entry.id),
                }, '彻底删除')),
              h('div', { style: { fontSize: 11, color: 'var(--cv-muted)' } },
                `原属「${entry.characterName}」　删除于 ${new Date(entry.deletedAt).toLocaleString()}`)))) )
    }

    /**
     * The gallery, sized to show exactly one row of thumbnails.
     *
     * Why measure rather than pick a number: the grid is `minmax(140px, 1fr)`, so a cell is
     * as wide as the panel divides it — around 180px in a narrow panel and 300px in a wide
     * one. A cell's height is 4/3 of its width, so the row follows the panel width, and any
     * constant is wrong for most window sizes. Measured once on mount and again whenever the
     * panel is resized, the height tracks it exactly.
     *
     * The measurement is a side effect, not a render-time value, because it has to wait for
     * layout: `offsetHeight` is not known until the browser has placed the grid.
     */
    function GallerySection(props) {
      const {
        generated, character, selected, libraryHeight, autoFit,
        onFit, onResize, onResizeEnd, onResetFit, onSelect, onOpen, onReveal, onRemove, onOpenLatest,
      } = props
      const galleryRef = React.useRef(null)
      const panelRef = React.useRef(null)

      // In auto-fit mode the panel follows the row height, re-measuring whenever the row
      // changes — which happens on a window resize, and also when a caption wraps to two
      // lines. In manual mode the measurement stops entirely, so the user's drag is final.
      React.useLayoutEffect(() => {
        if (!autoFit) return undefined
        const gallery = galleryRef.current
        if (!gallery) return undefined
        // One CELL, not the grid: with three rows on screen, the grid's height would fit all
        // three and defeat the whole point.
        const cell = gallery.firstElementChild
        if (!cell) return undefined

        const measure = () => {
          const oneRow = Math.ceil(cell.getBoundingClientRect().height + 10)
          const current = panelRef.current?.offsetHeight ?? 0
          // Written only when it actually differs: this callback also runs on every observed
          // resize, and an unconditional write would set state each time it fires.
          if (Math.abs(oneRow - current) > 6) onFit?.(oneRow)
        }

        measure()
        if (typeof ResizeObserver === 'function') {
          const observer = new ResizeObserver(measure)
          observer.observe(gallery)
          return () => observer.disconnect()
        }
        // Without ResizeObserver the fit happens once per mount, which is still better than a
        // constant, and the manual drag remains available.
        return undefined
        // `generated.length` matters: the first render may have no cells to measure at all.
      }, [autoFit, generated.length, onFit])

      const oneRowHeight = () => {
        const cell = galleryRef.current?.firstElementChild
        return cell ? Math.ceil(cell.getBoundingClientRect().height + 10) : 0
      }

      const body = generated.length === 0
        ? h('div', { className: 'cv-empty' },
          h('b', null, '这里是空的'),
          h('span', null, '出图完成后，每一张都会出现在这里。'))
        : h('div', { className: 'cv-gallery', ref: galleryRef },
          ...[...generated].reverse().map((asset) => h(GalleryCell, {
            key: asset.id,
            asset,
            characterId: character.id,
            selected: selected?.id === asset.id,
            onSelect,
            onOpen,
            onReveal,
            onRemove,
          })))

      return h('div', null,
        h('h3', { style: { margin: '0 0 4px', fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 } },
          `图库（${generated.length}）`,
          h('span', { style: { flex: '1 1 auto' } }),
          generated.length > 0
            ? h('button', {
              className: 'cv-btn', 'data-size': 'sm', disabled: !onOpenLatest,
              onClick: onOpenLatest,
            }, '看最新一张')
            : null),
        // Fixed height, draggable. Without it the gallery grew with every render and pushed
        // the preview above it out of the panel.
        h(ResizablePanel, {
          panelRef,
          height: libraryHeight,
          defaultHeight: 0,
          label: '图库',
          onResize,
          onResizeEnd,
          footerLeft: `${generated.length} 张　高度 ${libraryHeight}px`
            + (autoFit ? '　一行高（自适应）' : '　固定'),
          footerRight: generated.length > 0
            ? h('button', {
              className: 'cv-btn', 'data-size': 'sm',
              title: '把高度调回刚好一张图，并跟随窗口变化',
              disabled: autoFit,
              onClick: () => {
                const oneRow = oneRowHeight()
                onResetFit?.()
                if (oneRow > 0) onFit?.(oneRow)
              },
            }, autoFit ? '一行高 ✓' : '一行高')
            : null,
          empty: null,
        }, body))
    }

    /**
     * A list with a fixed height the user can drag.
     *
     * Used by both the task list and the gallery, because they are the same problem: a
     * growing collection inside a panel that must not grow with it. Only the contents differ.
     *
     * Three things it has to get right.
     *
     *  - The height belongs to the USER, not the content. An unbounded list pushes whatever
     *    is below it out of view — the gallery grew until the preview above it was gone.
     *  - The drag is driven by pointer DELTAS, never by the pointer's absolute position: the
     *    grab bar moves as it is dragged, so reading `clientY` directly feeds the bar's own
     *    movement into the next calculation and the drag runs away.
     *  - The bar sits ABOVE the list. Dragging up makes the list taller, which is one line of
     *    arithmetic (`start - current`) and would be a minute of confusion if inverted.
     */
    function ResizablePanel(props) {
      const {
        children, height, onResize, onResizeEnd, defaultHeight, panelRef,
        footerLeft, footerRight, empty, label,
      } = props
      const [dragging, setDragging] = React.useState(false)
      const [live, setLive] = React.useState(height)
      // `defaultHeight: 0` means "there is no magic number to go back to" — the caller knows
      // how to derive the right height (the gallery measures a row), so it supplies its own
      // reset in `footerRight` and the generic button is left out.
      const hasDefault = Number(defaultHeight) > 0

      // The end-of-drag value lives in a ref because the pointer-up handler closes over the
      // state of the render that STARTED the drag, where `live` is already stale.
      const liveRef = React.useRef(live)
      React.useEffect(() => { liveRef.current = live }, [live])
      React.useEffect(() => { setLive(height) }, [height])

      const clamp = (value) => Math.max(120, Math.min(720, Math.round(value)))

      function beginDrag(event) {
        event.preventDefault()
        const startY = event.clientY
        const startHeight = live
        setDragging(true)
        const target = event.currentTarget
        try { target.setPointerCapture?.(event.pointerId) } catch { /* capture is a nicety */ }

        const onMove = (moveEvent) => {
          // Dragging UP is a negative delta and must GROW the panel, hence `start - current`.
          const next = clamp(startHeight + (startY - moveEvent.clientY))
          setLive(next)
          onResize?.(next)
        }
        const onUp = () => {
          setDragging(false)
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', onUp)
          window.removeEventListener('pointercancel', onUp)
          try { target.releasePointerCapture?.(event.pointerId) } catch { /* already released */ }
          onResizeEnd?.(liveRef.current)
        }
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp)
        window.addEventListener('pointercancel', onUp)
      }

      return h('div', { className: 'cv-resizable', ref: panelRef },
        h('div', {
          className: 'cv-taskgrip',
          'data-dragging': dragging ? '1' : '0',
          role: 'separator',
          'aria-orientation': 'horizontal',
          'aria-label': `拖动以调整${label ?? '列表'}高度`,
          'aria-valuenow': live,
          'aria-valuemin': 120,
          'aria-valuemax': 720,
          tabIndex: 0,
          title: hasDefault ? '上下拖动调整高度（双击恢复默认）' : '上下拖动调整高度',
          onPointerDown: beginDrag,
          onDoubleClick: () => { if (hasDefault) onResizeEnd?.(defaultHeight) },
          onKeyDown: (event) => {
            // Keyboard-accessible, because a pointer-only control is one some people cannot
            // use at all. 16px steps, 64px with Shift.
            const step = event.shiftKey ? 64 : 16
            if (event.key === 'ArrowUp') { event.preventDefault(); onResizeEnd?.(clamp(live + step)) }
            if (event.key === 'ArrowDown') { event.preventDefault(); onResizeEnd?.(clamp(live - step)) }
          },
        }, h('i', null)),
        h('div', { className: 'cv-tasklist', style: { height: live } },
          React.Children.count(children) === 0 ? (empty ?? null) : children),
        h('div', { className: 'cv-taskfoot' },
          h('span', null, footerLeft ?? `${live}px`),
          h('span', { style: { flex: '1 1 auto' } }),
          footerRight ?? null,
          hasDefault ? h('button', {
            className: 'cv-btn', 'data-size': 'sm',
            onClick: () => onResizeEnd?.(defaultHeight),
          }, '默认高度') : null))
    }

    /**
     * One thumbnail. Two gestures, both expected: a single click puts it in the preview above,
     * a double click opens it full screen. The two icons are shortcuts to the file itself and
     * to deleting it, which is what people reach for once they can see the picture.
     */
    function GalleryCell(props) {
      const { asset, characterId, selected, onSelect, onOpen, onReveal, onRemove } = props
      return h('div', { className: 'cv-gcell' },
        h('button', {
          className: 'cv-gitem', 'data-on': selected ? '1' : '0',
          onClick: () => onSelect(asset),
          onDoubleClick: () => onOpen(asset),
          title: `${asset.label}\n单击预览 · 双击放大`,
        },
          h('img', { src: api.assetUrl(characterId, asset.id), alt: asset.label, loading: 'lazy' }),
          h('div', { className: 'cv-gmeta' }, asset.label)),
        h('div', { className: 'cv-gtools' },
          h('button', {
            className: 'cv-gtool', title: '打开文件所在位置',
            onClick: (e) => { e.stopPropagation(); onReveal(asset) },
          }, '📂'),
          h('button', {
            className: 'cv-gtool', title: '删除这张图',
            onClick: (e) => { e.stopPropagation(); onRemove(asset) },
          }, '✕')))
    }

    /**
     * The HD-upscale controls for the picture currently in the preview.
     *
     * Each factor shows the size it would actually produce, because the ceilings are real: a
     * 2048-wide view cannot reach 4x on this machine, and a button labelled "4x" that quietly
     * yields 2.25x is worse than one that says so before it is pressed. The sizes come from the
     * same `upscalePlan` the host runs, so the promise and the result cannot disagree.
     */
    function UpscaleBar(props) {
      const { asset, upscale, busy, onUpscale, lastPlan } = props
      /**
       * The factor picked but not yet committed.
       *
       * This is the mis-press guard: choosing used to start the job outright, so a slip cost a
       * half-minute GPU run and a cancelled queue slot. Selecting is now free, and only the
       * confirm button spends anything.
       */
      const [pending, setPending] = React.useState(null)
      const source = lastPlan?.source ?? null
      // The archived picture's own size, which is what the factor multiplies. `lastPlan` is the
      // authoritative copy once a request has been made; before that there is nothing to read
      // it from without loading the file, so the buttons stay enabled and the SERVER decides,
      // reporting the real numbers in its answer.
      const width = source?.width ?? null
      const height = source?.height ?? null
      const ceiling = upscale?.ceiling ?? null

      /**
       * What this factor would produce right now, including the clamp.
       *
       * Mirrors the host's `upscalePlan`, so a button label is the truth rather than an
       * aspiration — and it is the reason the ceiling is reported to the panel at all. A "4×"
       * that quietly yields 2.25× is worse than a button that says so before it is pressed.
       */
      const preview = (factor) => {
        if (!width || !height) return null
        const maxPixels = Number(ceiling?.maxPixels) > 0 ? Number(ceiling.maxPixels) : Infinity
        const maxEdge = Number(ceiling?.maxEdge) > 0 ? Number(ceiling.maxEdge) : Infinity
        const w = Math.round(width * factor)
        const h = Math.round(height * factor)
        if (w * h <= maxPixels && w <= maxEdge && h <= maxEdge) {
          return { width: w, height: h, factor, clamped: false }
        }
        const scale = Math.min(
          1,
          Math.sqrt(maxPixels / (width * height * factor * factor)),
          maxEdge / (width * factor),
          maxEdge / (height * factor),
        )
        const effective = Math.max(1, Math.floor(factor * scale * 100) / 100)
        return {
          width: Math.round(width * effective),
          height: Math.round(height * effective),
          factor: effective,
          clamped: effective < factor - 0.005,
        }
      }

      if (asset.source?.upscaled) {
        const s = asset.source
        return h('div', { className: 'cv-upscale' },
          h('span', { className: 'cv-badge', 'data-tone': 'ok' }, `已放大 ${s.factor}×`),
          h('span', { className: 'cv-hint', style: { margin: 0 } },
            `${s.width}×${s.height} → ${asset.label.split(' · ').pop()}　用 ${s.model}`),
          h('span', { className: 'cv-hint', style: { margin: 0 } }, '要从原图再放大，请在下面选中原图。'))
      }

      // Reverted: this used to fall back to a built-in factor list while `status` was still in
      // flight, so the control stayed visible from the first frame. It is back to a plain wait
      // state on request. The practical cost is that an upscale control that has not loaded yet
      // shows nothing, which is the "I cannot find the feature" report it was added for.
      if (!upscale) {
        return h('div', { className: 'cv-upscale' },
          h('span', { className: 'cv-hint', style: { margin: 0 } }, '读取放大模型…'))
      }
      if (!upscale.supported) {
        return h('div', { className: 'cv-upscale' },
          h('span', { className: 'cv-badge', 'data-tone': 'warn' }, '高清放大不可用'),
          h('span', { className: 'cv-hint', style: { margin: 0 } },
            'ComfyUI 里没有上采样模型。把 ESRGAN 系模型放进 models/upscale_models 后刷新即可。'))
      }

      const plans = (upscale.factors ?? []).map((factor) => ({ factor, plan: preview(factor) }))
      const chosen = plans.find((entry) => entry.factor === pending) ?? null

      return h('div', { className: 'cv-upscale' },
        h('span', { className: 'cv-upscale-label' }, '高清放大'),
        h('div', { className: 'cv-chips' },
          ...plans.map(({ factor, plan }) => h('button', {
            key: factor,
            className: 'cv-chip',
            // Selecting only. Picking a factor used to START a half-minute GPU job, which meant a
            // misread label or a slip of the mouse cost real time — and the cost lands on the GPU
            // queue, not on the click. A step of its own is the whole point.
            'data-on': pending === factor ? '1' : '0',
            disabled: busy,
            title: plan
              ? `${width}×${height} → ${plan.width}×${plan.height}`
                + (plan.clamped ? `\n${factor}× 超过本机上限，实际按 ${plan.factor}× 出图` : '')
              : `放大 ${factor} 倍`,
            onClick: () => setPending(pending === factor ? null : factor),
          }, `${factor}×`, plan?.clamped
            ? h('span', { className: 'cv-chip-note' }, `→${plan.factor}×`)
            : null))),

        // The confirmation appears only once something is selected, and it repeats the numbers
        // next to the thing that commits them — the figures were previously an arm's length away
        // from the button, which is what made mis-pressing possible in the first place.
        h(UpscaleConfirm, {
          chosen,
          width,
          height,
          busy,
          onConfirm: () => { const f = pending; setPending(null); onUpscale(f) },
          onCancel: () => setPending(null),
        }),

        h('span', { className: 'cv-hint', style: { margin: 0 } },
          width && height
            ? `原图 ${width}×${height}　模型 ${lastPlan?.model ?? upscale.model}`
            : `模型 ${upscale.model}`),
        lastPlan?.clamped
          ? h('span', { className: 'cv-warn' }, `注意：${lastPlan.reason}`)
          : null,
        ceiling?.maxPixels
          ? h('span', { className: 'cv-hint', style: { margin: 0 } },
            `本机当前上限 ${(ceiling.maxPixels / 1e6).toFixed(0)}MP / 单边 ${ceiling.maxEdge}px`)
          : null)
    }

    /**
     * The commit step for an upscale.
     *
     * Split out from the bar so both of its states can be rendered and asserted on directly: the
     * idle hint, and the confirmation carrying the exact sizes. It is the piece that exists purely
     * to stop a mis-press, so it is the piece worth testing on its own.
     */
    function UpscaleConfirm(props) {
      const { chosen, width, height, busy, onConfirm, onCancel } = props
      if (!chosen) {
        return h('span', { className: 'cv-hint', style: { margin: 0 } }, '先选一个倍数，再点「开始放大」。')
      }
      const plan = chosen.plan
      return h('div', { className: 'cv-upscale-confirm' },
        h('span', { className: 'cv-upscale-what' },
          plan && width && height
            ? `${width}×${height} → ${plan.width}×${plan.height}（${(plan.width * plan.height / 1e6).toFixed(1)}MP）`
            : `${chosen.factor}×`),
        h('button', {
          className: 'cv-btn', 'data-variant': 'primary', 'data-size': 'sm',
          disabled: busy,
          onClick: onConfirm,
        }, busy ? '正在放大…' : `开始放大 ${plan?.factor ?? chosen.factor}×`),
        h('button', {
          className: 'cv-btn', 'data-size': 'sm',
          disabled: busy,
          onClick: onCancel,
        }, '取消'))
    }

    /** One queued or finished render, with whatever progress is actually known. */
    function RunRow(props) {
      const { run, onCancel } = props
      const tone = run.status === 'done' ? 'ok' : run.status === 'running' ? 'warn' : 'err'
      const state = run.status === 'running'
        ? (run.phase === 'queued' ? '排队' : run.phase === 'validating' ? '准备' : '出图')
        : run.status === 'done' ? '完成' : run.status === 'cancelled' ? '已取消' : '失败'

      // Two different progress signals, and they mean different things:
      //   `sampling` is the steps inside ONE generation (from ComfyUI's WebSocket);
      //   `current/total` is how many generations of this run are finished.
      // Showing only the second is why a 25-step image looked like it was stuck: the bar
      // sat at 0% for a minute, then jumped to 100%.
      const sampling = run.sampling ?? null
      const jobDone = run.total > 0 ? run.current / run.total : 0
      const jobPart = sampling?.total > 0 ? (sampling.current / sampling.total) / Math.max(1, run.total) : 0
      const percent = run.status === 'done' ? 100 : Math.min(100, Math.round((jobDone + jobPart) * 100))

      return h('div', { className: 'cv-run' },
        h('div', { className: 'cv-run-top' },
          h('span', { className: 'cv-badge', 'data-tone': tone }, state),
          h('span', { className: 'cv-grow', title: run.label }, run.label),
          h('span', { style: { color: 'var(--cv-muted)', fontSize: 11, whiteSpace: 'nowrap' } },
            formatDuration(run.elapsedMs)),
          run.status === 'running'
            ? h('button', { className: 'cv-btn', 'data-size': 'sm', onClick: () => onCancel(run.id) }, '取消')
            : null),
        run.message ? h('div', { style: { fontSize: 11, color: 'var(--cv-muted)' } }, run.message) : null,
        run.status === 'running' || run.status === 'done'
          ? h('div', { className: 'cv-run-meter' },
            h('div', { className: 'cv-progress' }, h('i', { style: { width: `${percent}%` } })),
            h('span', { className: 'cv-run-pct' },
              sampling?.total > 0
                ? `${sampling.current}/${sampling.total} 步`
                : run.total > 0 ? `${run.current}/${run.total}` : `${percent}%`))
          : null,
        run.error ? h('div', { className: 'cv-err' }, run.error.message) : null)
    }

    // ------------------------------------------------------------ panel icon

    function PanelIcon(props) {
      const size = Number(props?.size) || 18
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true', focusable: 'false',
      },
        h('circle', { cx: 7.5, cy: 8, r: 2.6 }),
        h('path', { d: 'M4 19c0-2.2 1.6-3.6 3.5-3.6S11 16.8 11 19' }),
        h('rect', { x: 13, y: 4.5, width: 7.5, height: 7.5, rx: 1.4 }),
        h('rect', { x: 13, y: 13.5, width: 7.5, height: 6, rx: 1.4 }),
        h('path', { d: 'M16.8 8.2h0M16.8 16.5h0' }))
    }

    function SettingsSection() {
      return h('div', { className: 'cv-root' },
        h('p', { className: 'cv-hint' },
          '角色多视图的所有设置（ComfyUI 地址、出图尺寸、模型、图片目录）都在「角色多视图」面板的「设置」里。'),
        h('p', { className: 'cv-hint' },
          '照片和出图保存在 DSH 主目录下的 characterviews 文件夹里，可以直接备份或拷到别的机器。'))
    }

    /**
     * Keeps a failure inside this panel.
     *
     * React's answer to a render error is to unmount the tree it was rendering, so an
     * unguarded throw here leaves the shell's main region blank — which is
     * indistinguishable from "the plugin never loaded", and cost a long debugging
     * session to tell apart. Catching it here turns that blank region into the actual
     * message, and the panel's neighbours keep working either way.
     */
    class PanelBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }

      static getDerivedStateFromError(error) {
        return { error }
      }

      componentDidCatch(error, info) {
        // The console copy is for devtools; the render below is for the person who
        // cannot open devtools.
        // eslint-disable-next-line no-console
        console.error('characterviews: 面板渲染失败', error, info)
      }

      render() {
        const error = this.state.error
        // Pass the children through untouched: re-creating them here would restart the
        // very render that just failed, in a loop.
        if (!error) return this.props.children
        const detail = String(error?.stack ?? error?.message ?? error)
        // Inline styling on purpose. This branch exists for the case where the plugin's
        // stylesheet is the thing that did not arrive, so it must not depend on it.
        return h('div', {
          style: {
            padding: 14, font: '13px/1.6 system-ui, sans-serif', color: '#f9fafb',
            display: 'flex', flexDirection: 'column', gap: 8,
          },
        },
          h('div', { style: { fontWeight: 600, fontSize: 14 } }, '角色多视图：面板渲染出错了'),
          h('div', { style: { opacity: 0.75 } }, '把下面这段发我就能定位。后端没受影响：已经在跑的出图任务仍会正常完成。'),
          h('pre', {
            style: {
              margin: 0, padding: 10, borderRadius: 8, background: '#00000059', color: '#ff8a80',
              font: '11px/1.5 ui-monospace, Consolas, monospace', whiteSpace: 'pre-wrap',
              maxHeight: 320, overflow: 'auto',
            },
          }, detail),
          h('div', { style: { display: 'flex', gap: 8 } },
            h('button', {
              className: 'cv-btn',
              style: { font: 'inherit', padding: '5px 11px', borderRadius: 7, cursor: 'pointer' },
              onClick: () => { this.setState({ error: null }) },
            }, '重试渲染'),
            h('button', {
              className: 'cv-btn',
              style: { font: 'inherit', padding: '5px 11px', borderRadius: 7, cursor: 'pointer' },
              onClick: () => { try { navigator.clipboard.writeText(detail) } catch { /* clipboard may be denied */ } },
            }, '复制错误')))
      }
    }

    const module = {
      inject: ['slots'],
      apply(ctx) {
        if (typeof document !== 'undefined') ensureStyles()

        // A sidebar icon whose list id addresses the main panel key below — the
        // panellist's own contract: "Each list id addresses the matching main panel".
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: 'characterviews',
          order: 45,
          label: '角色多视图',
        }, PanelIcon))

        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: 'characterviews',
        }, () => h(PanelBoundary, null, h(Studio))))

        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'characterviews',
          order: 80,
          label: '角色多视图',
        }, SettingsSection))
      },
    }

    /**
     * Components, exposed for this plugin's own render tests.
     *
     * Defined non-enumerably on purpose: the module loader reads `inject` and `apply`,
     * and a loader that validates the exported shape would see an unexpected third key
     * in `Object.keys()`. The tests reach it by name.
     */
    Object.defineProperty(module, '__test__', {
      value: {
        Studio, Lightbox, Settings, SettingsSection, PanelIcon, PanelBoundary, GallerySection,
        RunRow, GalleryCell, ResizablePanel, UpscaleBar, UpscaleConfirm, describeAngle, formatBytes,
      },
      enumerable: false,
    })

    return module
  },
})
