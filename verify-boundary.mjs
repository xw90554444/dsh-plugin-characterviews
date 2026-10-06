/**
 * Verify the two things that were changed to make a failure visible instead of blank:
 *   1. the stylesheet is injected when the factory runs (not when `apply()` is called);
 *   2. the error boundary turns a throw into readable text.
 *
 * `renderToString` deliberately does NOT invoke error boundaries — SSR rethrows — so the
 * boundary is exercised through its own methods rather than through a render pass.
 */
import { pathToFileURL, fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import React from 'react'
import { renderToString } from 'react-dom/server'
import ReactDOM from 'react-dom'

// Resolved from this file so the suite runs from any checkout.
const HERE = dirname(fileURLToPath(import.meta.url))

const styles = []
globalThis.document = {
  getElementById: (id) => styles.find((s) => s.id === id) ?? null,
  createElement: () => ({ id: '', textContent: '' }),
  head: { append(el) { styles.push(el) } },
  body: { nodeType: 1, appendChild() {}, removeChild() {}, insertBefore() {} },
}
globalThis.window = { __ModuleLoader__: { load: (s) => { globalThis.__SPEC__ = s } } }
globalThis.__CHARACTERVIEWS__ = { token: 't', prefix: '/p' }
// `globalThis.navigator` is a getter-only property on Node 24; define over it.
try { globalThis.navigator = { clipboard: { writeText() {} } } } catch {
  Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText() {} } }, configurable: true })
}

await import(pathToFileURL(join(HERE, 'lib', 'client.js')).href)
const mod = globalThis.__SPEC__.factory((name) => {
  if (name === 'react') return React
  if (name === 'react-dom') return ReactDOM
  throw new Error(`unexpected require(${name})`)
})

let failures = 0
const check = (label, condition, extra = '') => {
  if (condition) console.log(`✓ ${label}${extra ? `  ${extra}` : ''}`)
  else { failures += 1; console.log(`✗ ${label}${extra ? `  ${extra}` : ''}`) }
}

// 1. styles at factory time
const css = styles[0]?.textContent ?? ''
check('factory 阶段就注入了样式', styles.length === 1, `${css.length} 字符`)
check('样式里含 .cv-root', css.includes('.cv-root'))
check('样式里含 .cv-empty', css.includes('.cv-empty'))

// 2. the boundary's own contract
const Boundary = mod.__test__.PanelBoundary
check('PanelBoundary 是个组件类', typeof Boundary === 'function')

const state = Boundary.getDerivedStateFromError(new Error('boom'))
check('getDerivedStateFromError 记录错误', state?.error instanceof Error)

const instance = new Boundary({ children: null })
instance.state = { error: new Error('故意炸一个，验证边界') }
instance.setState = () => {}
const html = renderToString(instance.render())
check('降级 UI 显示标题', html.includes('面板渲染出错了'))
check('降级 UI 带上原始错误', html.includes('故意炸一个'))
check('降级 UI 不依赖外部样式表', html.includes('style='))

// 3. normal path passes children through untouched
const normal = new Boundary({ children: React.createElement('div', { id: 'ok' }, '正常内容') })
const normalHtml = renderToString(normal.render())
check('无错误时原样渲染子节点', normalHtml.includes('正常内容'))

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
