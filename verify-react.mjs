/**
 * Render the panel with real React and realistic API payloads.
 *
 * The hand-rolled hook shim could only prove "no exception in the render body". Real
 * React additionally validates the element tree — undefined children, invalid props,
 * bad hook order — and throws with a stack pointing at the offending line. That is the
 * difference between "my code did not throw" and "React accepts this tree".
 */
import { pathToFileURL, fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

// Resolved from THIS file, not from a hardcoded checkout path: an absolute path here would make
// the suite unrunnable on any other machine, and it would publish the author's directory layout.
const HERE = dirname(fileURLToPath(import.meta.url))
const CLIENT = join(HERE, 'lib', 'client.js')
// The source itself is needed for the one claim that cannot be checked by rendering: that a
// factor button's handler selects rather than starts.
const source = readFileSync(CLIENT, 'utf8')
const React = (await import('react')).default
const { renderToString } = await import('react-dom/server')
const ReactDOM = await import('react-dom')

// ------------------------------------------------------------- fake browser

const styleTags = []
globalThis.document = {
  getElementById: (id) => styleTags.find((t) => t.id === id) ?? null,
  createElement: () => ({ id: '', textContent: '' }),
  head: { append(el) { styleTags.push(el) } },
  // The lightbox portals into `document.body`. Without one it falls back to an inline render,
  // which would not exercise the portal path at all.
  body: { nodeType: 1, appendChild() {}, removeChild() {}, insertBefore() {} },
}
globalThis.window = { __ModuleLoader__: { load: (spec) => { globalThis.__SPEC__ = spec } } }
globalThis.__CHARACTERVIEWS__ = { token: 'test-token', prefix: '/characterviews-api' }
globalThis.confirm = () => false
globalThis.FileReader = class { readAsDataURL() {} }

// ------------------------------------------------------- realistic fixtures

const asset = (id, kind, label, viewpoint = null) => ({
  id, kind, ext: 'png', label, viewpoint, createdAt: '2026-10-05T08:00:00.000Z',
  bytes: 1_411_135, runId: 'run-abc12345', batchId: 'batch-abc12345',
  comfy: { filename: `CV_x_${id}_00001_.png`, subfolder: 'characterviews', type: 'output', promptId: 'p1' },
  url: `/asset/c1/${id}`,
})

const character = {
  id: 'c1',
  name: '测试角色',
  notes: '',
  dir: 'C:\\Users\\tester\\.dsh\\characterviews\\characters\\测试角色',
  createdAt: '2026-10-05T08:00:00.000Z',
  updatedAt: '2026-10-05T08:10:00.000Z',
  lastRunId: 'run-abc12345',
  assets: [
    asset('photo-1', 'photo', 'me.png'),
    asset('view-1', 'view', '正面 + 左侧 + 背面', 'front+left+back'),
  ],
  batches: [{
    id: 'batch-abc12345', runId: 'run-abc12345', createdAt: '2026-10-05T08:10:00.000Z',
    mode: 'three', layout: 'sheet', viewKeys: ['front', 'left', 'back'],
    viewLabels: ['正面', '左侧', '背面'], photoAssetId: 'photo-1',
    seed: 1234, steps: 25, preset: 'standard', canvas: { width: 1984, height: 672 },
    assetIds: ['view-1'], comfyFiles: [], prompt: 'p', negative: 'n',
  }],
}

const status = {
  ok: true,
  comfy: {
    version: '0.38.2', baseUrl: 'http://127.0.0.1:8188',
    outputDir: 'C:\\ComfyUI\\output',
    inputDir: 'C:\\ComfyUI\\input',
    models: { diffusionModel: 'qwen_image_2.1_int8_convrot.safetensors', textEncoder: 'qwen3vl_8b_bf16.safetensors', vae: 'qwen_image_2.1_vae_bf16.safetensors', lora: null },
    modelLists: { diffusionModel: ['qwen_image_2.1_int8_convrot.safetensors'], textEncoder: ['qwen3vl_8b_bf16.safetensors'], vae: ['qwen_image_2.1_vae_bf16.safetensors'], lora: [] },
    nodes: { ok: true, missing: [] },
  },
  capacity: { level: 'blocked', notes: ['可用显存 0.9 GB'], vramFreeBytes: 966_367_232, ramFreeBytes: 5_000_000_000 },
  paths: {
    pluginRoot: 'C:\\Users\\tester\\.dsh\\characterviews',
    characters: 'C:\\Users\\tester\\.dsh\\characterviews\\characters',
    outputRoot: 'C:\\Users\\tester\\.dsh\\characterviews\\characters',
    libraryFile: 'C:\\Users\\tester\\.dsh\\characterviews\\library.json',
    comfyOutput: 'C:\\ComfyUI\\output',
  },
  libraryBytes: 8_400_000,
  config: {
    comfy: { baseUrl: 'http://127.0.0.1:8188', megapixels: 1.3, preset: 'standard', referenceResolution: 1024, outputDir: null, keepComfyCopy: true, models: { diffusionModel: null, textEncoder: null, vae: null, lora: null } },
    prompt: { background: 'grey', styleSuffix: 'photorealistic', negativeSuffix: 'blurry' },
    ui: { activeCharacterId: 'c1', lastMode: 'three', sheetLayout: 'sheet' },
  },
  problems: [],
  modes: [
    { key: 'single', label: '单视图' }, { key: 'three', label: '三视图' },
    { key: 'multi', label: '多视图' }, { key: 'custom', label: '任意角度' },
  ],
  layouts: [{ key: 'sheet' }, { key: 'separate' }],
  viewpoints: [{ key: 'front', label: '正面', en: 'front view', yaw: 0, pitch: 0 }],
  presets: { draft: '草稿', standard: '标准', quality: '精细' },
}

const run = {
  id: 'run-abc12345', kind: 'render', label: '三视图 · 测试角色 · 正面/左侧/背面', characterId: 'c1',
  status: 'running', phase: 'sampling', message: '采样中（12s）：正面 + 左侧 + 背面',
  current: 1, total: 3, result: null, error: null,
  startedAt: Date.now() - 12_000, finishedAt: null, elapsedMs: 12_000, promptId: 'p1',
}

// ---------------------------------------------------------------- fetch mock

const responses = {
  '/status': { ok: true, status },
  '/characters': { ok: true, characters: [{ id: 'c1', name: '测试角色', photoCount: 1, viewCount: 1, coverAssetId: 'view-1', lastRunId: 'run-abc12345', notes: '', createdAt: '', updatedAt: '' }] },
  '/characters/c1': { ok: true, character },
  '/runs': { ok: true, runs: [run] },
}
globalThis.fetch = async (url) => {
  const path = String(url).replace('/characterviews-api', '')
  const body = responses[path] ?? responses[path.replace(/\?.*$/, '')] ?? { ok: true }
  return { ok: true, status: 200, json: async () => body }
}

// --------------------------------------------------------------------- boot

await import(pathToFileURL(CLIENT).href)
const mod = globalThis.__SPEC__.factory((name) => {
  if (name === 'react') return React
  // The panel portals its lightbox through `react-dom`; the real module is used so the check
  // is about the plugin's call, not about a stub agreeing with itself.
  if (name === 'react-dom') return ReactDOM
  throw new Error(`unexpected require(${name})`)
})

// react-dom/server does not run effects, so the component renders its INITIAL state.
// That is the state the shell mounts, and therefore the state that can take it down.
const cases = [
  ['Studio（初始状态）', mod.__test__.Studio, {}],
  ['Settings（有完整 status）', mod.__test__.Settings, { status, onSaved: async () => {}, setNotice() {}, setError() {} }],
  ['SettingsSection', mod.__test__.SettingsSection, {}],
  ['PanelIcon', mod.__test__.PanelIcon, { size: 18 }],
  ['Lightbox（无图，应返回 null）', mod.__test__.Lightbox, { asset: null, characterId: 'c1', onClose() {}, onReveal() {}, onSave() {} }],
  ['Lightbox（有图，走 portal）', mod.__test__.Lightbox, {
    asset: character.assets.find((a) => a.kind === 'view'), characterId: 'c1',
    onClose() {}, onReveal() {}, onSave() {},
  }],
  // The gallery derives its own height from a measured row, so both branches matter: with
  // pictures to measure, and with none, where there is nothing to measure at all.
  ['GallerySection（有图）', mod.__test__.GallerySection, {
    generated: character.assets.filter((a) => a.kind === 'view'),
    character, selected: null, libraryHeight: 260,
    onResize() {}, onResizeEnd() {}, onSelect() {}, onOpen() {}, onReveal() {}, onRemove() {}, onOpenLatest() {},
  }],
  ['GallerySection（空）', mod.__test__.GallerySection, {
    generated: [], character, selected: null, libraryHeight: 260,
    onResize() {}, onResizeEnd() {}, onSelect() {}, onOpen() {}, onReveal() {}, onRemove() {}, onOpenLatest() {},
  }],
  ['RunRow（采样中）', mod.__test__.RunRow, { run, onCancel() {} }],
  ['RunRow（已完成）', mod.__test__.RunRow, {
    run: { ...run, status: 'done', phase: 'done', sampling: null, error: null }, onCancel() {},
  }],
  ['RunRow（失败）', mod.__test__.RunRow, {
    run: { ...run, status: 'failed', phase: 'failed', sampling: null, error: { code: 'x', message: '出图失败' } },
    onCancel() {},
  }],
  // Three states of the upscale bar, and each one is a different decision: no model installed,
  // ready, and already upscaled (where the buttons must NOT be offered again).
  ['UpscaleBar（模型未装）', mod.__test__.UpscaleBar, {
    asset: { id: 'v1', label: '正面', source: null },
    upscale: { factors: [1.5, 2, 3, 4], models: [], model: null, supported: false },
    busy: false, onUpscale() {}, lastPlan: null,
  }],
  // Cold start: `status` has not arrived, so `upscale` is null. The control must stay VISIBLE —
  // a panel that shows only "loading" reads as "this feature is not here", which is precisely
  // the report it produced in the field.
  ['UpscaleBar（status 未到）', mod.__test__.UpscaleBar, {
    asset: { id: 'v1', label: '正面', source: null },
    upscale: null,
    busy: false, onUpscale() {}, lastPlan: null,
  }],
  ['UpscaleBar（可放大）', mod.__test__.UpscaleBar, {
    asset: { id: 'v1', label: '正面', source: null },
    upscale: { factors: [1.5, 2, 2.5, 3, 3.5, 4], models: ['4xNomos8k_atd_jpg.pth'], model: '4xNomos8k_atd_jpg.pth', supported: true },
    busy: false, onUpscale() {},
    lastPlan: { source: { width: 768, height: 1024 }, model: '4xNomos8k_atd_jpg.pth', clamped: true, reason: '超过上限，已缩小' },
  }],
  ['UpscaleBar（已是放大图）', mod.__test__.UpscaleBar, {
    asset: {
      id: 'v2', label: '正面 · 2×',
      source: { upscaled: true, factor: 2, width: 768, height: 1024, model: '4xNomos8k_atd_jpg.pth' },
    },
    upscale: { factors: [1.5, 2], models: ['m'], model: 'm', supported: true },
    busy: false, onUpscale() {}, lastPlan: null,
  }],
  // The clamped case: a small ceiling and a big source, so the labels must show the factor that
  // will ACTUALLY run rather than the one that was clicked. This is the branch where a quiet
  // substitution would hide, so it gets its own case.
  ['UpscaleBar（被上限钳制）', mod.__test__.UpscaleBar, {
    asset: { id: 'v3', label: '正面 + 左侧 + 背面', source: null },
    upscale: {
      factors: [1.5, 2, 2.5, 3, 3.5, 4],
      models: ['4xNomos8k_atd_jpg.pth'], model: '4xNomos8k_atd_jpg.pth', supported: true,
      ceiling: { maxPixels: 12_000_000, maxEdge: 4096, known: true },
    },
    busy: false, onUpscale() {},
    lastPlan: {
      source: { width: 2048, height: 1536 }, model: '4xNomos8k_atd_jpg.pth',
      clamped: true, reason: '4× 会得到 8192×6144，超过上限，已改为 1.95×',
    },
  }],
  // The mis-press guard: nothing is committed until the confirm button is pressed, so both
  // states of that step are rendered directly rather than inferred from the bar.
  ['UpscaleConfirm（未选倍数）', mod.__test__.UpscaleConfirm, {
    chosen: null, width: 992, height: 1312, busy: false, onConfirm() {}, onCancel() {},
  }],
  ['UpscaleConfirm（已选 2×）', mod.__test__.UpscaleConfirm, {
    chosen: { factor: 2, plan: { width: 1984, height: 2624, factor: 2, clamped: false } },
    width: 992, height: 1312, busy: false, onConfirm() {}, onCancel() {},
  }],
  ['UpscaleConfirm（执行中）', mod.__test__.UpscaleConfirm, {
    chosen: { factor: 4, plan: { width: 3968, height: 5248, factor: 4, clamped: false } },
    width: 992, height: 1312, busy: true, onConfirm() {}, onCancel() {},
  }],
]

let failed = 0
let coldStartHtml = ''
for (const [label, Component, props] of cases) {
  try {
    // `react-dom/server` cannot render a portal, and says so in as many words. The point of
    // this case is that the component reaches the portal call at all — a missing
    // `react-dom` require or a throw before it would read as a different error.
    const html = renderToString(React.createElement(Component, props))
    if (label.includes('status 未到')) coldStartHtml = html
    console.log(`✓ ${label}  (${html.length} 字符)`)
  } catch (error) {
    const portalLimit = /Portals are not currently supported by the server renderer/.test(error.message)
    if (portalLimit && label.includes('portal')) {
      console.log(`✓ ${label}  （已确认走到 createPortal；SSR 不支持 portal 属预期）`)
      continue
    }
    failed += 1
    console.log(`✗ ${label}`)
    console.log(`   ${error.message.split('\n')[0]}`)
    const frame = (error.stack ?? '').split('\n').find((l) => l.includes('client.js'))
    if (frame) console.log(`   ${frame.trim()}`)
  }
}

// The portal itself is verified in the browser-less sense: the require resolved and the call
// is reachable. `createPortal` doing the right thing is react-dom's job, not this plugin's.
console.log(`${typeof ReactDOM.createPortal === 'function' ? '✓' : '✗'} react-dom 的 createPortal 可用`)

// ---------------------------------------------------------------------------
// Behavioural check: selecting a factor must not start anything.
//
// `UpscaleBar` holds state, so it cannot be invoked outside a render — but `UpscaleConfirm` is
// pure and its commit path is exercised directly. The selection guard is then asserted two ways:
// on the handler React actually attached to a factor chip, and on the source line that calls
// `onUpscale`. Rendering alone could never catch "the button renders right but fires the job".
// ---------------------------------------------------------------------------
{
  const collectButtons = (element, found = []) => {
    if (!element || typeof element !== 'object') return found
    // `$$typeof` is what React itself uses to recognise an element. Checking `type === 'button'`
    // alone misses nested ones, because `props.children` is an array for most elements.
    if (element.$$typeof && element.type === 'button') found.push(element)
    const children = Array.isArray(element.props?.children) ? element.props.children : [element.props?.children]
    for (const child of children) collectButtons(child, found)
    return found
  }
  const textOf = (element) => {
    const children = Array.isArray(element.props?.children) ? element.props.children : [element.props?.children]
    return children.map((c) => (typeof c === 'string' ? c : c?.props?.children ?? '')).join('')
  }

  const upstreamSource = source.slice(
    source.indexOf('function UpscaleBar('),
    source.indexOf('function UpscaleConfirm('),
  )
  const chipHandlerSelects = /onClick:\s*\(\)\s*=>\s*setPending\(/.test(upstreamSource)
  // Anchored to the COMMIT handler, not to "the substring appears": the bar also passes
  // `onConfirm: () => { ...onUpscale(f) }` down to the confirm step, and that is the only place it
  // may appear. What must not exist is a handler on a factor chip that reaches it.
  const commitWired = /onConfirm:\s*\(\)\s*=>\s*\{[\s\S]*?onUpscale\(f\)/.test(upstreamSource)
  const noDirectStart = !/onClick:\s*\(\)\s*=>\s*onUpscale\(/.test(upstreamSource)
  // Nothing in the bar itself offers to start: the commit button lives in the confirm step, which
  // renders only once `chosen` exists.
  const startLabelInBar = upstreamSource.includes('开始放大')
  console.log(`${chipHandlerSelects ? '✓' : '✗'} 倍数按钮的 onClick 只做选中（setPending），不启动任务`)
  console.log(`${commitWired ? '✓' : '✗'} 提交路径挂在 onConfirm 上（由确认按钮触发）`)
  console.log(`${noDirectStart ? '✓' : '✗'} 没有任何 onClick 直接调用 onUpscale`)
  console.log(`${!startLabelInBar ? '✓' : '✗'} 未选倍数时放大条本身不含「开始放大」入口`)
  if (!chipHandlerSelects || !commitWired || !noDirectStart || startLabelInBar) failed += 1

  // The idle state, on the pure component that renders it.
  const idleHtml = renderToString(React.createElement(mod.__test__.UpscaleConfirm, {
    chosen: null, width: 992, height: 1312, busy: false, onConfirm() {}, onCancel() {},
  }))
  const idleHasButton = /<button/.test(idleHtml)
  console.log(`${!idleHasButton ? '✓' : '✗'} 未选倍数时确认步骤里没有按钮（无从误触）`)
  if (idleHasButton) failed += 1

  // The commit path, on the pure component: it must reach onUpscale with the chosen factor.
  let committed = null
  const confirmTree = mod.__test__.UpscaleConfirm({
    chosen: { factor: 2, plan: { width: 1984, height: 2624, factor: 2, clamped: false } },
    width: 992, height: 1312, busy: false,
    onConfirm: () => { committed = 2 },
    onCancel: () => { committed = 'cancelled' },
  })
  const buttons = collectButtons(confirmTree)
  const confirmButton = buttons.find((b) => textOf(b).includes('开始放大'))
  const cancelButton = buttons.find((b) => textOf(b) === '取消')
  if (confirmButton) confirmButton.props.onClick()
  const afterConfirm = committed
  committed = null
  if (cancelButton) cancelButton.props.onClick()
  console.log(`${confirmButton && afterConfirm === 2 ? '✓' : '✗'} 点「开始放大」才提交  -> ${JSON.stringify(afterConfirm)}`)
  console.log(`${cancelButton && committed === 'cancelled' ? '✓' : '✗'} 「取消」不提交  -> ${JSON.stringify(committed)}`)
  console.log(`${buttons.length === 2 ? '✓' : '✗'} 确认步骤只有两个按钮（没有多余入口）  找到 ${buttons.length} 个`)
  if (!confirmButton || afterConfirm !== 2 || !cancelButton || committed !== 'cancelled' || buttons.length !== 2) failed += 1
}

// The CSS is injected by apply(); a broken template literal would only show up here.
console.log(`\n注入的 <style> 标签: ${styleTags.length}  长度 ${styleTags[0]?.textContent?.length ?? 0}`)
if (styleTags[0]) {
  const css = styleTags[0].textContent
  let depth = 0
  let broke = false
  for (const ch of css) {
    if (ch === '{') depth += 1
    else if (ch === '}') { depth -= 1; if (depth < 0) { broke = true; break } }
  }
  console.log(`CSS 括号平衡: ${broke || depth !== 0 ? `不平衡 (depth=${depth})` : '平衡'}`)

  // The overlay is portalled into document.body, so viewport units would be correct here —
  // but percentages are still better, and the failure this guards against is the one that
  // actually happened: sizing the overlay from the WINDOW while it was clipped to the PANEL.
  const overlayRule = /\.cv-lightbox\{([^}]*)\}/.exec(css)?.[1] ?? ''
  const imgRule = /\.cv-lightbox-img\{([^}]*)\}/.exec(css)?.[1] ?? ''
  const checks = [
    ['遮罩用 position:fixed 铺满', /position:fixed/.test(overlayRule) && /inset:0/.test(overlayRule)],
    ['遮罩不再用 vw/vh 量尺寸', !/(\d+)v[wh]/.test(overlayRule) && !/(\d+)v[wh]/.test(imgRule)],
    ['图片按容器百分比适配', /max-width:100%/.test(imgRule) && /max-height:100%/.test(imgRule)],
    ['图片不因 flex 被压扁', /min-height:0/.test(imgRule)],
    ['遮罩不裁掉缩放后的图片', !/overflow:hidden/.test(imgRule)],
  ]
  for (const [label, ok] of checks) {
    if (!ok) failed += 1
    console.log(`${ok ? '✓' : '✗'} ${label}`)
  }

  // The cold-start state, asserted on the markup.
  //
  // This used to require the factor buttons to be visible BEFORE `status` arrived. That fallback
  // was reverted on request, so what is asserted now is the WAIT state. The value of keeping the
  // case at all is that it proves the component still RENDERS in that state — a control that
  // simply returns nothing would look identical in the panel and leave no trace here.
  const coldOk = coldStartHtml.includes('读取放大模型')
  if (!coldOk) failed += 1
  console.log(`${coldOk ? '✓' : '✗'} 模型未读到时显示等待提示且不抛错  ${coldOk ? '「读取放大模型…」' : coldStartHtml.slice(0, 60)}`)
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 个用例失败`)
