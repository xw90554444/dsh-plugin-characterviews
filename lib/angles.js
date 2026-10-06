/**
 * Viewpoints and the prompt text that produces them.
 *
 * Pure module — no I/O, no ComfyUI, no DSH — so the angle names, the compass
 * arithmetic and the compiled prompts can all be unit-tested and reused by the
 * agent tools without touching the render path.
 *
 * The vocabulary here is deliberately the vocabulary image models were captioned
 * with: "front view", "left side view", "back view", "three-quarter view",
 * "low angle", "high angle". A model asked for "135 度方位角" produces mush, so the
 * Chinese label is for the UI and the English clause is what rides the prompt.
 */

/** The four modes the panel offers. */
export const MODES = {
  single: {
    key: 'single',
    label: '单视图',
    hint: '一张图，一个角度。角度可选正面 / 侧面 / 背面，或用滑杆指定任意角度。',
  },
  three: {
    key: 'three',
    label: '三视图',
    hint: '正面 + 侧面 + 背面。默认合成一张角色设定图，也可切成三张独立图。',
  },
  multi: {
    key: 'multi',
    label: '多视图',
    hint: '正面 + 侧面 + 背面 + 仰视 45° + 俯视 45°，五个角度。适合直接当建模参考。',
  },
  custom: {
    key: 'custom',
    label: '任意角度',
    hint: '自己挑任意几个角度组合成一张设定图。',
  },
}

/**
 * The canonical viewpoints.
 *
 * `yaw` is degrees clockwise seen from above, 0 = facing the camera. `pitch` is
 * degrees of camera elevation, positive = camera above looking down.
 */
export const VIEWPOINTS = {
  front: { key: 'front', label: '正面', en: 'front view', yaw: 0, pitch: 0 },
  frontLeft34: { key: 'frontLeft34', label: '左前 3/4', en: 'three-quarter front view turned to the left', yaw: -45, pitch: 0 },
  left: { key: 'left', label: '左侧', en: 'left side view, seen from the subject\'s left', yaw: -90, pitch: 0 },
  backLeft34: { key: 'backLeft34', label: '左后 3/4', en: 'three-quarter back view turned to the left', yaw: -135, pitch: 0 },
  back: { key: 'back', label: '背面', en: 'back view, seen from directly behind', yaw: 180, pitch: 0 },
  backRight34: { key: 'backRight34', label: '右后 3/4', en: 'three-quarter back view turned to the right', yaw: 135, pitch: 0 },
  right: { key: 'right', label: '右侧', en: 'right side view, seen from the subject\'s right', yaw: 90, pitch: 0 },
  frontRight34: { key: 'frontRight34', label: '右前 3/4', en: 'three-quarter front view turned to the right', yaw: 45, pitch: 0 },
  low45: { key: 'low45', label: '仰视 45°', en: 'low angle view: the camera is placed 45 degrees below the subject\'s eye level and points up at them, so the body reads from below', yaw: 0, pitch: -45 },
  high45: { key: 'high45', label: '俯视 45°', en: 'high angle view: the camera is placed 45 degrees above the subject\'s eye level and points down at them, so the body reads from above', yaw: 0, pitch: 45 },
  low30: { key: 'low30', label: '仰视 30°', en: 'low angle view: the camera is placed 30 degrees below the subject\'s eye level and points up at them, so the body reads from below', yaw: 0, pitch: -30 },
  high30: { key: 'high30', label: '俯视 30°', en: 'high angle view: the camera is placed 30 degrees above the subject\'s eye level and points down at them, so the body reads from above', yaw: 0, pitch: 30 },
  topDown: { key: 'topDown', label: '正俯视', en: 'top-down bird\'s eye view: the camera is directly overhead pointing straight down at the subject', yaw: 0, pitch: 80 },
}

/** The presets the three fixed modes expand to, in sheet order. */
export const MODE_VIEWS = {
  three: ['front', 'left', 'back'],
  multi: ['front', 'left', 'back', 'low45', 'high45'],
}

/**
 * Which expansion the UI offers for three/multi.
 *
 *  - `sheet`    one generation containing every angle: proportions, lighting and
 *               costume are identical across views because they were sampled
 *               together, which is the whole reason to prefer it.
 *  - `separate` one generation per angle: each view gets the full canvas, and a
 *               bad view can be re-rolled without touching the good ones.
 */
export const LAYOUTS = {
  sheet: { key: 'sheet', label: '一张设定图', hint: '所有角度画在同一张图里，比例与光照最统一。' },
  separate: { key: 'separate', label: '每个角度一张', hint: '分辨率更高，可以单独重抽某一张。' },
}

/** Human label for a free yaw/pitch pair, used by the custom-angle UI. */
export function describeAngle(yaw, pitch) {
  const y = normaliseYaw(yaw)
  const p = clampPitch(pitch)
  const yawWord = y === 0 ? '正面'
    : y === 180 ? '背面'
      : y === 90 ? '右侧'
        : y === 270 ? '左侧'
          : y < 90 ? `右前 ${Math.round(y)}°`
            : y < 180 ? `右后 ${Math.round(180 - y)}°`
              : y < 270 ? `左后 ${Math.round(y - 180)}°`
                : `左前 ${Math.round(360 - y)}°`
  const pitchWord = p === 0 ? '' : p > 0 ? ` 俯视 ${Math.round(p)}°` : ` 仰视 ${Math.round(-p)}°`
  return `${yawWord}${pitchWord}`
}

/** The English clause for a free yaw/pitch pair, in model-friendly wording. */
export function describeAngleEn(yaw, pitch) {
  const y = normaliseYaw(yaw)
  const p = clampPitch(pitch)
  const parts = []
  if (y === 0) parts.push('front view, facing the camera directly')
  else if (y === 180) parts.push('back view, seen from directly behind')
  else if (y === 90) parts.push('right side view, seen from the subject\'s right')
  else if (y === 270) parts.push('left side view, seen from the subject\'s left')
  else if (y < 90) parts.push(`three-quarter front view turned ${Math.round(y)} degrees to the subject's right`)
  else if (y < 180) parts.push(`three-quarter back view turned ${Math.round(180 - y)} degrees to the subject's right`)
  else if (y < 270) parts.push(`three-quarter back view turned ${Math.round(y - 180)} degrees to the subject's left`)
  else parts.push(`three-quarter front view turned ${Math.round(360 - y)} degrees to the subject's left`)

  if (p !== 0) {
    // Wording matters more than it looks. "camera raised 45 degrees looking up" made
    // the model tilt the SUBJECT'S head instead of moving the camera; naming the camera
    // as the thing that moves, and saying the pose does not change, is what fixed it.
    if (p > 0) {
      parts.push('high angle view: the camera is placed above the subject\'s eye level and points down at them, '
        + 'the subject keeps the same standing pose and looks straight ahead, only the camera has moved')
    } else {
      parts.push('low angle view: the camera is placed below the subject\'s eye level and points up at them, '
        + 'the subject keeps the same standing pose and looks straight ahead, only the camera has moved')
    }
  }
  return parts.join(', ')
}

export function normaliseYaw(yaw) {
  const n = Number(yaw)
  if (!Number.isFinite(n)) return 0
  return ((Math.round(n) % 360) + 360) % 360
}

export function clampPitch(pitch) {
  const n = Number(pitch)
  if (!Number.isFinite(n)) return 0
  return Math.max(-80, Math.min(80, Math.round(n)))
}

/**
 * A viewpoint from a free angle, so custom views share the exact shape of the
 * named ones and nothing downstream needs a special case for them.
 */
export function viewpointFor(yaw, pitch) {
  const y = normaliseYaw(yaw)
  const p = clampPitch(pitch)
  const named = Object.values(VIEWPOINTS).find((v) => normaliseYaw(v.yaw) === y && v.pitch === p)
  if (named) return named
  return { key: `custom-${y}-${p}`, label: describeAngle(y, p), en: describeAngleEn(y, p), yaw: y, pitch: p }
}

/**
 * Resolve a mode + angle choices into the ordered list of viewpoints to render.
 *
 * @param {object} request
 * @param {'single'|'three'|'multi'|'custom'} request.mode
 * @param {number} [request.yaw] single mode's angle
 * @param {number} [request.pitch]
 * @param {string[]} [request.views] custom mode's viewpoint keys
 * @returns {object[]} viewpoints, never empty
 */
export function planViews(request = {}) {
  const mode = MODES[request.mode] ? request.mode : 'three'
  if (mode === 'single') return [viewpointFor(request.yaw ?? 0, request.pitch ?? 0)]
  if (mode === 'custom') {
    const picked = (Array.isArray(request.views) ? request.views : [])
      .map((key) => VIEWPOINTS[key] ?? (typeof key === 'object' ? viewpointFor(key.yaw, key.pitch) : null))
      .filter(Boolean)
    return picked.length > 0 ? picked.slice(0, 8) : MODE_VIEWS.three.map((k) => VIEWPOINTS[k])
  }
  return MODE_VIEWS[mode].map((k) => VIEWPOINTS[k])
}

// ---------------------------------------------------------------------------
// Prompt compilation
// ---------------------------------------------------------------------------

/** The paragraph that keeps the character recognisable, quoted in the UI too. */
export const IDENTITY_CLAUSE = 'Use the reference photograph as the authoritative identity reference: '
  + 'keep exactly the same person — identical facial features, face shape, hairstyle and hair colour, '
  + 'skin tone, body proportions, and the exact same clothing and footwear as in the reference. '
  + 'Do not beautify, re-style, age, or slim the subject, and do not change the outfit.'

/** What every render of this kind is: a character turnaround, not a portrait. */
export const TURNAROUND_CLAUSE = 'A single clean character turnaround reference image of one consistent '
  + 'character, all views showing the same person at the same scale and the same standing pose, '
  + 'arms relaxed at the sides, neutral expression, full body visible from head to feet, '
  + 'the character centred in every view, identical lighting across all views.'

/**
 * Compile the positive prompt for one request.
 *
 * @param {object} request
 * @param {object[]} request.views the planned viewpoints, in sheet order
 * @param {'sheet'|'separate'} [request.layout]
 * @param {object} [request.config] the plugin config (for background / style suffix)
 * @param {string} [request.notes] free-text the user added (costume, props, mood)
 * @returns {{positive:string, layout:'sheet'|'separate'}}
 */
export function compilePrompt(request = {}) {
  const views = request.views ?? []
  const layout = request.layout === 'separate' ? 'separate' : 'sheet'
  const background = request.config?.prompt?.background ?? ''
  const style = request.config?.prompt?.styleSuffix ?? ''
  const notes = typeof request.notes === 'string' ? request.notes.trim() : ''

  const lines = []
  if (layout === 'separate' && views.length === 1) {
    // A single view is NOT a sheet: asking for a "turnaround reference sheet" in a
    // 1:1.5 frame makes the model draw a tiny figure in a corner of a white page.
    lines.push('A single full-body character reference photograph.')
    lines.push(IDENTITY_CLAUSE)
    lines.push(`Camera angle: ${views[0].en}. The body is turned to that angle; keep the same person.`)
  } else if (layout === 'separate') {
    // Every angle is its own generation, but each one must still be described as a
    // cut-out of the same turnaround or the model reinvents the character.
    lines.push('A single full-body character reference image, one view only.')
    lines.push(IDENTITY_CLAUSE)
    lines.push(`Camera angle: ${views[0].en}. The body is turned to that angle; keep the same person, `
      + 'the same proportions and the same clothing as in the reference photograph.')
  } else {
    const { columns, rows } = sheetGrid(views.length)
    lines.push(TURNAROUND_CLAUSE)
    lines.push(IDENTITY_CLAUSE)
    // The layout is stated in words AND as a numbered reading order, because "draw five
    // views" alone reliably produces four or six, or the same view twice.
    const grid = rows > 1
      ? `arranged in a ${rows}-row grid of ${columns} views per row, reading left to right then top to bottom`
      : `arranged left to right in a single row`
    lines.push(`The sheet is a character reference sheet showing exactly ${views.length} views of this one character, `
      + `${grid}, in this order: ${views.map((v, i) => `${i + 1}) ${v.en}`).join('; ')}.`)
    if (rows > 1) lines.push(`Every row is fully occupied except possibly the last; there are exactly ${views.length} figures in total.`)
    if (views.length > 1) {
      lines.push('Every view is the same person at the same scale, standing on the same ground line, '
        + 'separated by clear space, no overlapping figures.')
      // A sheet is where "same pose, different camera" gets lost: asked for a low angle,
      // the model tilted the subject's head down instead of moving the camera down.
      lines.push('The standing pose is identical in every view and the head stays level, facing straight ahead; '
        + 'only the camera position changes between views.')
    }
    lines.push('Keep the head at a consistent size across the views so the turnaround reads as one coherent sheet.')
  }

  if (background) lines.push(background)
  if (notes) lines.push(notes)
  if (style) lines.push(style)

  return { positive: lines.join(' '), layout }
}

/**
 * Compile the negative prompt.
 *
 * The sheet-specific entries matter: multi-view prompts fail most often by
 * producing a crowd of *different* people, or by collapsing into a mirrored copy
 * of the same pose.
 */
export function compileNegative(request = {}) {
  const views = request.views ?? []
  const layout = request.layout === 'separate' ? 'separate' : 'sheet'
  const base = [
    'different person, inconsistent identity, different face, different hairstyle, changed clothing',
    'extra limbs, extra fingers, fused fingers, deformed hands, distorted face',
    'text, letters, numbers, labels, captions, watermark, signature, logo',
    'jpeg artifacts, blurry, low resolution, oversaturated',
  ]
  if (layout === 'sheet' && views.length > 1) {
    base.push('duplicated identical poses, mirrored copy of the same view, collage of different characters',
      'cropped head, cropped feet, overlapping bodies, cluttered background')
  }
  const suffix = request.config?.prompt?.negativeSuffix
  if (typeof suffix === 'string' && suffix.trim()) base.push(suffix.trim())
  return base.join(', ')
}

/**
 * The exact text of one request, for the UI's "prompt" disclosure and for the
 * agent tools. Nothing here is called during rendering that is not also shown here,
 * so what the panel displays is what ComfyUI was asked for.
 */
export function describePlan(request = {}) {
  const views = request.views ?? []
  const { positive, layout } = compilePrompt({ ...request, views })
  return {
    layout,
    viewCount: views.length,
    viewLabels: views.map((v) => v.label),
    positive,
    negative: compileNegative({ ...request, views }),
  }
}

/**
 * How a sheet is laid out: how many views to a row.
 *
 * A single row is the cleanest thing to ask a model for, but it hits a wall: the canvas
 * width is capped at 2048 px, so a five-view strip gives every figure about 410 px and
 * nothing can be done about it from the megapixel side. Wrapping to at most three per row
 * turns the same width into 683 px per figure, which is the difference between a
 * silhouette and a face.
 */
export function sheetGrid(viewCount) {
  const columns = viewCount <= 3 ? Math.max(1, viewCount) : 3
  const rows = Math.max(1, Math.ceil(viewCount / columns))
  return { columns, rows }
}

// ---------------------------------------------------------------------------
// Output resolution
// ---------------------------------------------------------------------------

/**
 * Aspect ratios offered for a view.
 *
 * `width`/`height` are the ratio's own numbers, kept as a pair rather than a fraction so
 * the common display ratios (4:5, 3:2) stay exactly representable.
 */
export const ASPECTS = {
  square: { key: 'square', label: '1:1 正方形', width: 1, height: 1 },
  portrait: { key: 'portrait', label: '3:4 竖版', width: 3, height: 4 },
  photo: { key: 'photo', label: '4:5 人像', width: 4, height: 5 },
  tall: { key: 'tall', label: '2:3 长竖版', width: 2, height: 3 },
  landscape: { key: 'landscape', label: '4:3 横版', width: 4, height: 3 },
  wide: { key: 'wide', label: '3:2 宽横版', width: 3, height: 2 },
  cinema: { key: 'cinema', label: '16:9 宽屏', width: 16, height: 9 },
}

/**
 * Lengths offered for a view's LONG edge, in pixels.
 *
 * The long edge is the number the user reasons about ("I want 1024"), and it makes the
 * output exact for the ratios that are squares of a common base: 1024 at 3:4 gives
 * 768×1024, which is a size people recognise. Snapping the SHORT edge instead would give
 * 1024×1365 — the same pixels, an unrecognisable number.
 */
export const EDGES = [512, 640, 768, 896, 1024, 1152, 1280, 1536, 2048]

/** The hard ceiling on either canvas dimension, from the sampler's own limits. */
export const MAX_EDGE = 2048
/** Qwen-Image 2.1's native range; past this it invents detail rather than resolving it. */
export const MAX_MEGAPIXELS = 4

const snap32 = (value) => Math.max(256, Math.min(MAX_EDGE, Math.round(value / 32) * 32))

/**
 * The canvas is the grid of views, and it is NOT snapped again.
 *
 * `viewPixels` already put the multiple of 32 in the frame; re-snapping the canvas would undo
 * the ratio a second time — a 16:9 view is 720 tall, and the canvas would push it to 736 and
 * hand back a picture that is not 16:9. The grid is an exact multiple of its cells, so the
 * multiple of 32 lands on the same value either way for horizontal multiplication, and the
 * vertical case keeps the height the user chose.
 */
const canvasSize = (view, grid) => ({
  width: Math.min(MAX_EDGE, view.width * grid.columns),
  height: Math.min(MAX_EDGE, view.height * grid.rows),
})

/**
 * The pixel size of ONE view.
 *
 * Only the LONG edge is snapped to a multiple of 32; the other side is derived from it and
 * rounded to a whole pixel. Snapping both is the obvious thing and it is wrong: 1280 at 16:9
 * becomes 1280×736 instead of 1280×720, because 720 is not a multiple of 32 and gets pushed
 * up. The sampler needs a well-formed multiple somewhere in the frame; the user needs the
 * ratio they picked, and one snapped dimension satisfies both. It also keeps the awkward
 * ratios honest — 4:5 at 1024 is 819, not 832, which is the difference between the shape
 * people asked for and a slightly different one.
 *
 * @param {string} aspectKey
 * @param {number} edge the long edge
 * @returns {{width:number, height:number}}
 */
export function viewPixels(aspectKey, edge) {
  const aspect = ASPECTS[aspectKey] ?? ASPECTS.portrait
  const target = Number.isFinite(Number(edge)) && Number(edge) > 0 ? Number(edge) : 1024
  const ratio = aspect.width / aspect.height
  const long = Math.max(256, Math.min(MAX_EDGE, Math.round(target / 32) * 32))
  const short = Math.max(64, Math.round(long / (ratio >= 1 ? ratio : 1 / ratio)))
  return ratio >= 1 ? { width: long, height: short } : { width: short, height: long }
}

/**
 * The pixel size of the whole generated image.
 *
 * The distinction matters and is easy to get wrong: for a sheet, the chosen resolution
 * describes ONE view, and the canvas is the grid that holds them. Returning the per-view
 * size as the canvas size would silently render a three-view sheet at a third of the
 * requested detail.
 *
 * The canvas is scaled down — never up — when the result would exceed either the edge cap
 * or the megapixel budget, so a large request degrades into a smaller picture rather than
 * into a rejected graph. `adjusted` says whether that happened, which is what the panel
 * reports instead of quietly handing back something other than what was asked for.
 *
 * @param {object} request
 * @param {string} [request.aspect] key of {@link ASPECTS}
 * @param {number} [request.edge] long edge of one view
 * @param {'sheet'|'separate'} [request.layout]
 * @param {number} [request.viewCount]
 * @returns {{width:number, height:number, view:{width:number,height:number}, megapixels:number, adjusted:boolean, reason:string|null}}
 */
export function canvasFor(request = {}) {
  const aspectKey = ASPECTS[request.aspect] ? request.aspect : 'portrait'
  const layout = request.layout === 'sheet' ? 'sheet' : 'separate'
  const viewCount = Math.max(1, Math.round(Number(request.viewCount) || 1))
  const asked = Number(request.edge) > 0 ? Number(request.edge) : 1024

  const single = layout === 'separate' || viewCount <= 1
  const grid = single ? { columns: 1, rows: 1 } : sheetGrid(viewCount)

  let edge = asked
  let scale = 1
  let reason = null

  for (let attempt = 0; attempt < 40; attempt += 1) {
    const view = viewPixels(aspectKey, edge)
    const { width, height } = canvasSize(view, grid)
    const megapixels = (width * height) / 1_000_000
    const overEdge = view.width > MAX_EDGE || view.height > MAX_EDGE || width > MAX_EDGE || height > MAX_EDGE
    const overBudget = megapixels > MAX_MEGAPIXELS + 1e-9
    if (!overEdge && !overBudget) {
      return {
        width,
        height,
        view,
        megapixels: Math.round(megapixels * 100) / 100,
        columns: grid.columns,
        rows: grid.rows,
        adjusted: Boolean(reason),
        reason,
      }
    }
    if (!reason) {
      reason = overEdge
        ? `超过单边 ${MAX_EDGE}px 上限，已自动缩小`
        : `超过 ${MAX_MEGAPIXELS}MP 预算，已自动缩小`
    }
    // Step down in 5% increments: small enough that the result stays close to the request,
    // coarse enough that the search terminates.
    scale -= 0.05
    if (scale <= 0.1) break
    edge = Math.max(256, Math.round(asked * scale))
  }

  const view = viewPixels(aspectKey, 256)
  const { width, height } = canvasSize(view, grid)
  return {
    width,
    height,
    view,
    megapixels: Math.round((width * height) / 10_000) / 100,
    columns: grid.columns,
    rows: grid.rows,
    adjusted: true,
    reason: reason ?? `已缩到 ${MAX_MEGAPIXELS}MP 以内`,
  }
}

/** The canvas aspect, for callers that only need the shape (the CSS preview, for one). */
export function aspectFor(layout, viewCount, aspectKey = 'portrait') {
  const canvas = canvasFor({ aspect: aspectKey, edge: 1024, layout, viewCount })
  return canvas.width / canvas.height
}

export default {
  MODES, VIEWPOINTS, MODE_VIEWS, LAYOUTS,
  ASPECTS, EDGES, MAX_EDGE, MAX_MEGAPIXELS,
  describeAngle, describeAngleEn, viewpointFor, planViews,
  compilePrompt, compileNegative, describePlan,
  aspectFor, canvasFor, viewPixels, sheetGrid,
  normaliseYaw, clampPitch,
}
