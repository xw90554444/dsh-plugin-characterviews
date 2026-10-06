/**
 * Which image model to bind to, and how hard to sample.
 *
 * Numeric resolution is NOT stored here: the canvas is derived at request time by
 * {@link resolutionFor} so a portrait stays portrait and a turnaround sheet stays
 * wide, instead of the megapixel budget being applied to a square.
 */

/**
 * Ranked preference for the installed image models.
 *
 * `qwen_image_2.1` first because this plugin depends on `TextEncodeQwenImage21`:
 * that node exists only for this family, and it is the one that accepts up to 16
 * reference images alongside the prompt — which is what makes "same person, other
 * angles" possible without a second model.
 */
export const IMAGE_PREFERRED = {
  diffusionModel: [
    'qwen_image_2.1_int8_convrot', // best quality-per-VRAM of the installed image models
    'qwen_image_2.1_bf16',
    'qwen_image_2.1_fp8',
    'qwen_image_2.1',
    'qwen_image_edit',
    'qwen_image',
  ],
  /**
   * The MAIN text encoder. `qwen3vl_8b_*` is what `TextEncodeQwenImage21` expects.
   *
   * The `*_pe_*` entries are a different animal: a prompt *enhancer* that rewrites
   * the prompt before encoding. Loading one as the text encoder yields soft, mushy
   * images, because an enhancer is not trained to condition the diffusion model.
   */
  textEncoder: [
    'qwen3vl_8b_bf16',
    'qwen3vl_8b_int8_convrot',
    'qwen3vl_8b_w4a8',
    'qwen3vl_4b_fp8_scaled',
    'qwen_3_4b_fp8_mixed',
  ],
  vae: ['qwen_image_2.1_vae_bf16', 'qwen_image_vae', 'qwen_image_2.1_vae'],
  lora: ['Qwen-Image-Lightning-4steps', 'Qwen-Image-Lightning'],
}

/**
 * Sampling presets.
 *
 * Step counts follow the official Qwen-Image 2.1 guidance (cfg 1, euler/simple,
 * roughly 25–50 steps; the shipped template starts at 25). The Lightning LoRA is a
 * distilled shortcut trained for ~4–8 steps — leaving it on for a final render
 * degrades the image, so it is confined to `draft`.
 */
export const IMAGE_PRESETS = {
  draft: { steps: 8, turbo: true, cfg: 1, samplerName: 'euler', scheduler: 'simple', label: '草稿（8 步 + Lightning）' },
  standard: { steps: 25, turbo: false, cfg: 1, samplerName: 'euler', scheduler: 'simple', label: '标准（25 步）' },
  quality: { steps: 40, turbo: false, cfg: 1, samplerName: 'euler', scheduler: 'simple', label: '精细（40 步）' },
}

/** Node classes the graph needs from the running ComfyUI. */
export const REQUIRED_NODES = [
  'UNETLoader',
  'CLIPLoader',
  'VAELoader',
  'TextEncodeQwenImage21',
  'EmptyLatentImage',
  'KSampler',
  'VAEDecode',
  'SaveImage',
  'LoadImage',
  'LoraLoaderModelOnly',
]

export function presetFor(name) {
  return IMAGE_PRESETS[name] ?? IMAGE_PRESETS.standard
}

/**
 * Canvas for a megapixel budget at a given aspect ratio, snapped to /32 and
 * clamped to what the model was trained on.
 *
 * @param {number} megapixels
 * @param {number} [aspect] width / height
 * @returns {{width:number, height:number}}
 */
export function resolutionFor(megapixels, aspect = 1) {
  const mp = Number.isFinite(megapixels) && megapixels > 0 ? Math.min(4, Math.max(0.5, megapixels)) : 1.3
  const ratio = Number.isFinite(aspect) && aspect > 0 ? Math.min(3, Math.max(1 / 3, aspect)) : 1
  const total = mp * 1_000_000
  const snap = (v) => Math.min(2048, Math.max(256, Math.round(v / 32) * 32))
  return {
    width: snap(Math.sqrt(total * ratio)),
    height: snap(Math.sqrt(total / ratio)),
  }
}

/**
 * Whether this render is even feasible on the machine ComfyUI reports.
 *
 * Qwen-Image 2.1 int8 is roughly 11 GB of weights, so free VRAM is the binding
 * constraint. This only ever warns: ComfyUI will happily offload to RAM and finish,
 * just slowly, and refusing to render would be worse than rendering slowly.
 */
export function assessCapacity(health) {
  const device = health?.devices?.[0]
  const vramFree = Number(device?.vramFreeBytes ?? 0)
  const ramFree = Number(health?.ramFreeBytes ?? 0)
  const notes = []
  let level = 'ok'

  if (vramFree && vramFree < 9 * 1024 ** 3) {
    level = vramFree < 4 * 1024 ** 3 ? 'blocked' : 'tight'
    notes.push(`可用显存 ${(vramFree / 1024 ** 3).toFixed(1)} GB —— 模型会被分块搬运，出图会明显变慢。`)
  }
  if (ramFree && ramFree < 12 * 1024 ** 3) {
    if (level !== 'blocked') level = 'tight'
    notes.push(`可用内存 ${(ramFree / 1024 ** 3).toFixed(1)} GB —— 显存不够时会往内存里卸，内存也紧张就会更慢。`)
  }
  return { level, notes, vramFreeBytes: vramFree || null, ramFreeBytes: ramFree || null }
}

/**
 * The zoom factors the panel offers.
 *
 * Not arbitrary on purpose. These models are trained to 4x and a non-integer request has to be
 * reached by upscaling and then resampling down, so the only meaningful choices are the ones
 * worth doing that dance for — and half-steps are where a person's eye stops seeing the
 * difference between two adjacent entries.
 */
export const UPSCALE_FACTORS = [1.5, 2, 2.5, 3, 3.5, 4]

/**
 * Ranked preference for the installed upscale models.
 *
 * Both are ESRGAN-family 4x networks. `4xNomos8k_atd_jpg` leads because it was trained with a
 * JPEG-degradation stage, which is what a photograph that has already been through a camera
 * and a resize actually looks like; `RealESRGAN_x4plus` is the generalist fallback.
 */
export const UPSCALE_PREFERRED = {
  model: ['4xNomos8k_atd_jpg', '4xNomos', 'RealESRGAN_x4plus', 'RealESRGAN', 'ESRGAN', '4x'],
}

/**
 * Output megapixels allowed per GB of free VRAM.
 *
 * Set CONSERVATIVELY (3 MP/GB), and the reason is a trap worth naming. The measured data point is
 * "50.3 MP succeeded with 7.3 GB free", which reads like ~7 MP/GB — but that is free memory, not
 * memory USED, and ComfyUI offloads to system RAM when VRAM runs short. The 50 MP run may never
 * have needed 7.3 GB of VRAM at all, so a ratio inferred from it could be wrong by a large factor
 * in the dangerous direction. One observation cannot establish a scaling law.
 *
 * At 3 MP/GB the machine measured allows ~4.4x the largest request actually tested, which covers
 * every real source size here — a 2048×1536 three-view sheet at 4x is 50 MP. Being wrong on this
 * side costs a retry at a lower factor, and the buttons show what each factor will really produce,
 * so the retry is an informed choice rather than a guess.
 */
export const UPSCALE_PIXELS_PER_GB = 3_000_000
export const MIN_UPSCALE_PIXELS = 8_000_000
export const MAX_UPSCALE_PIXELS_CEILING = 200_000_000
/** ComfyUI's `ImageScale` dimensions are INTs; this is the practical top for a still image. */
export const MAX_UPSCALE_EDGE_CEILING = 16384

/**
 * What this machine can upscale to right now.
 *
 * @param {number} vramFreeBytes
 * @returns {{maxPixels:number, maxEdge:number, vramFreeBytes:number, known:boolean}}
 */
export function upscaleCeiling(vramFreeBytes) {
  const bytes = Number(vramFreeBytes)
  if (!Number.isFinite(bytes) || bytes <= 0) {
    // Unknown memory: fall back to the smallest sensible ceiling rather than guessing generously.
    return { maxPixels: MIN_UPSCALE_PIXELS, maxEdge: 8192, vramFreeBytes: null, known: false }
  }
  const gb = bytes / 1024 ** 3
  const maxPixels = Math.max(
    MIN_UPSCALE_PIXELS,
    Math.min(MAX_UPSCALE_PIXELS_CEILING, Math.round(gb * UPSCALE_PIXELS_PER_GB)),
  )
  const maxEdge = Math.max(4096, Math.min(MAX_UPSCALE_EDGE_CEILING, Math.round(gb * 2048)))
  return { maxPixels, maxEdge, vramFreeBytes: bytes, known: true }
}

/**
 * What an upscale at this factor would actually produce.
 *
 * Returns the size that WILL be produced, which is not always the size that was asked for: the
 * ceilings clamp it, and `clamped` says so — with the reason — rather than quietly handing back a
 * different picture.
 *
 * @param {{width:number, height:number}} source
 * @param {number} factor
 * @param {{maxPixels:number, maxEdge:number}} [ceiling] from {@link upscaleCeiling}
 */
export function upscalePlan(source, factor, ceiling = null) {
  const width = Math.max(1, Math.round(Number(source?.width) || 0))
  const height = Math.max(1, Math.round(Number(source?.height) || 0))
  const wanted = UPSCALE_FACTORS.includes(Number(factor)) ? Number(factor) : 2
  const maxPixels = Number(ceiling?.maxPixels) > 0 ? Number(ceiling.maxPixels) : MAX_UPSCALE_PIXELS_CEILING
  const maxEdge = Number(ceiling?.maxEdge) > 0 ? Number(ceiling.maxEdge) : MAX_UPSCALE_EDGE_CEILING

  let target = { width: Math.round(width * wanted), height: Math.round(height * wanted) }
  const overPixels = target.width * target.height > maxPixels
  const overEdge = target.width > maxEdge || target.height > maxEdge
  if (!overPixels && !overEdge) {
    return { ...target, factor: wanted, requested: wanted, clamped: false, reason: null }
  }

  const reason = overEdge
    ? `${wanted}× 会得到 ${target.width}×${target.height}，单边超过上限 ${maxEdge}px`
    : `${wanted}× 会得到 ${target.width}×${target.height}（${(target.width * target.height / 1e6).toFixed(1)}MP），超过上限 ${(maxPixels / 1e6).toFixed(0)}MP`
  const scale = Math.min(
    1,
    Math.sqrt(maxPixels / (width * height * wanted * wanted)),
    maxEdge / (width * wanted),
    maxEdge / (height * wanted),
  )
  // Two decimals: a finer step would name a factor nobody can distinguish from its neighbour.
  const effective = Math.max(1, Math.floor(wanted * scale * 100) / 100)
  target = { width: Math.round(width * effective), height: Math.round(height * effective) }
  return {
    ...target,
    factor: effective,
    requested: wanted,
    clamped: true,
    reason: `${reason}，已改为 ${effective}×（${target.width}×${target.height}）`,
  }
}

/** Pick the installed upscale model, honouring an explicit override. */
export function resolveUpscaleModel(available = [], override = null) {
  if (override && available.includes(override)) return override
  for (const hint of UPSCALE_PREFERRED.model) {
    const match = available.find((name) => String(name).toLowerCase().includes(hint.toLowerCase()))
    if (match) return match
  }
  return available[0] ?? null
}

export default {
  IMAGE_PREFERRED, IMAGE_PRESETS, REQUIRED_NODES, presetFor, resolutionFor, assessCapacity,
  UPSCALE_FACTORS, UPSCALE_PREFERRED, upscalePlan, upscaleCeiling, resolveUpscaleModel,
  UPSCALE_PIXELS_PER_GB, MIN_UPSCALE_PIXELS, MAX_UPSCALE_PIXELS_CEILING, MAX_UPSCALE_EDGE_CEILING,
}
