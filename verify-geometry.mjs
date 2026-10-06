/**
 * Assert that the panel's preview geometry and the host's real geometry agree.
 *
 * The panel shows the output size live, which means the arithmetic exists twice: once in
 * `lib/angles.js` (which actually renders) and once in `lib/client.js` (which draws the
 * preview). A preview that is merely close is worse than no preview — it is a promise about
 * the output that turns out to be false after a two-minute render.
 *
 * Run: node dsh-plugin-characterviews/verify-geometry.mjs
 */
import { readFileSync } from 'node:fs'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// Resolved from this file so the suite runs from any checkout.
const HERE = dirname(fileURLToPath(import.meta.url))
const CLIENT = join(HERE, 'lib', 'client.js')

const angles = await import(pathToFileURL(join(HERE, 'lib', 'angles.js')).href)

// ------------------------------------------------------- load the client's copy

const source = readFileSync(CLIENT, 'utf8')
const styleTags = []
globalThis.document = {
  getElementById: () => null,
  createElement: () => ({ id: '', textContent: '' }),
  head: { append(el) { styleTags.push(el) } },
}
globalThis.window = { __ModuleLoader__: { load: (spec) => { globalThis.__SPEC__ = spec } } }
globalThis.__CHARACTERVIEWS__ = { token: 't', prefix: '/p' }
await import(pathToFileURL(CLIENT).href)

// The geometry helpers are module-private, so they are pulled out of the source by name
// rather than exported for the sake of a test: an export that exists only for tests is a
// public API nobody asked for.
/**
 * Pull one geometry helper out of the client source by name.
 *
 * Both spellings are handled, because the file uses both and the difference is not a signal:
 * `const snap32 = (v) => …` and `function canvasFor(…) {…}` are the same thing here. Each
 * helper is a self-contained expression, so the extractor walks braces to find its end
 * rather than guessing at a line.
 */
const grab = (name) => {
  const arrow = new RegExp(`const ${name} = (\\([^)]*\\)|[A-Za-z_$][\\w$]*) =>`)
  const arrowMatch = arrow.exec(source)
  const head = arrowMatch
    ? source.slice(arrowMatch.index + arrowMatch[0].length)
    : null
  if (arrowMatch) {
    // Arrow form: everything up to the matching brace of the body, or one line if the body
    // is a bare expression.
    const open = head.indexOf('{')
    if (open < 0) return `const ${name} = ${arrowMatch[1]} => ${head.split('\n')[0].trim()}`
    const body = sliceBraces(head, open)
    return `const ${name} = ${arrowMatch[1]} => ${body}`
  }
  const start = source.indexOf(`function ${name}(`)
  if (start < 0) throw new Error(`client.js 里找不到 ${name}()`)
  const open = source.indexOf('{', source.indexOf('(', start))
  return `function ${name}${sliceBraces(source, open, source.indexOf('(', start))}`
}

/** The balanced `{...}` block starting at `open`, including the parameter list before it. */
function sliceBraces(text, open, paramsFrom = -1) {
  let depth = 0
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1
    else if (text[i] === '}') {
      depth -= 1
      if (depth === 0) return text.slice(paramsFrom >= 0 ? paramsFrom : 0, i + 1)
    }
  }
  throw new Error('括号不平衡')
}

const clientModule = { exports: {} }
void clientModule
// eslint-disable-next-line no-new-func
const factory = new Function(
  'ASPECTS', 'EDGES', 'MAX_EDGE', 'MAX_MEGAPIXELS',
  `${grab('snap32')}\n${grab('sheetGrid')}\n${grab('viewPixels')}\n${grab('canvasFor')}
   return { snap32, sheetGrid, viewPixels, canvasFor }`,
)
const client = factory(
  [
    { key: 'square', width: 1, height: 1 },
    { key: 'portrait', width: 3, height: 4 },
    { key: 'photo', width: 4, height: 5 },
    { key: 'tall', width: 2, height: 3 },
    { key: 'landscape', width: 4, height: 3 },
    { key: 'wide', width: 3, height: 2 },
    { key: 'cinema', width: 16, height: 9 },
  ],
  [512, 640, 768, 896, 1024, 1152, 1280, 1536, 2048],
  2048,
  4,
)

// ------------------------------------------------------------------- compare

let failures = 0
let cases = 0
const mismatches = []

for (const aspect of Object.keys(angles.ASPECTS)) {
  for (const edge of angles.EDGES) {
    for (const layout of ['sheet', 'separate']) {
      for (const viewCount of [1, 2, 3, 4, 5, 6, 8]) {
        cases += 1
        const host = angles.canvasFor({ aspect, edge, layout, viewCount })
        const panel = client.canvasFor(aspect, edge, layout, viewCount)
        const same = host.width === panel.width
          && host.height === panel.height
          && host.view.width === panel.view.width
          && host.view.height === panel.view.height
          && host.columns === panel.columns
          && host.rows === panel.rows
          && host.adjusted === panel.adjusted
          && Math.abs(host.megapixels - panel.megapixels) < 0.011
        if (!same && mismatches.length < 12) {
          mismatches.push(`${aspect} @${edge} ${layout} x${viewCount}: 宿主 ${host.width}x${host.height}(view ${host.view.width}x${host.view.height}, adj=${host.adjusted}) vs 面板 ${panel.width}x${panel.height}(view ${panel.view.width}x${panel.view.height}, adj=${panel.adjusted})`)
        }
        if (!same) failures += 1
      }
    }
  }
}

// The aspect key lists must match too, or the panel would offer a ratio the host rejects.
const panelAspects = [...source.matchAll(/\{ key: '(\w+)', label: '[^']+', width: (\d+), height: (\d+) \}/g)]
  .map((m) => ({ key: m[1], width: Number(m[2]), height: Number(m[3]) }))
const hostAspects = Object.values(angles.ASPECTS).map((a) => ({ key: a.key, width: a.width, height: a.height }))
const aspectsMatch = JSON.stringify(panelAspects) === JSON.stringify(hostAspects)

const panelEdges = JSON.parse((/const EDGES = (\[[^\]]+\])/.exec(source) ?? [])[1] ?? '[]')
const edgesMatch = JSON.stringify(panelEdges) === JSON.stringify(angles.EDGES)

console.log(`比较了 ${cases} 种组合（7 比例 × 9 边长 × 2 布局 × 7 视图数）`)
console.log(`${failures === 0 ? '✓' : '✗'} 画布几何一致${failures === 0 ? '' : `（${failures} 处不一致）`}`)
for (const line of mismatches) console.log(`   ${line}`)
console.log(`${aspectsMatch ? '✓' : '✗'} 比例列表一致（${hostAspects.map((a) => a.key).join(', ')}）`)
console.log(`${edgesMatch ? '✓' : '✗'} 边长列表一致（${angles.EDGES.join(', ')}）`)

// A couple of concrete sizes people recognise, as a sanity check on the numbers themselves.
const samples = [
  ['单视图 3:4 @1024', { aspect: 'portrait', edge: 1024, layout: 'separate', viewCount: 1 }, 768, 1024],
  ['单视图 1:1 @1024', { aspect: 'square', edge: 1024, layout: 'separate', viewCount: 1 }, 1024, 1024],
  ['单视图 16:9 @1280', { aspect: 'cinema', edge: 1280, layout: 'separate', viewCount: 1 }, 1280, 720],
]
for (const [label, request, width, height] of samples) {
  const got = angles.canvasFor(request)
  const ok = got.width === width && got.height === height
  if (!ok) failures += 1
  console.log(`${ok ? '✓' : '✗'} ${label} = ${got.width}×${got.height}（期望 ${width}×${height}）`)
}

if (!aspectsMatch || !edgesMatch) failures += 1
console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
