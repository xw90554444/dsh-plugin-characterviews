/**
 * Programmatic ComfyUI graph construction for the character turnaround.
 *
 * No hand-exported workflow JSON: every node class, input name and enum below was
 * read from the live server's `/object_info`, and the plugin re-checks the assembled
 * graph against that catalog before queueing it.
 *
 * The graph is the Qwen-Image 2.1 template with one deliberate difference from the
 * plain text-to-image case: the user's photograph rides `TextEncodeQwenImage21`'s
 * autogrow `images` group. Qwen-Image 2.1 does t2i and reference-image editing with
 * ONE encoder — with references attached, the model sees the subject in the text
 * encoder AND the image is spliced into the sequence — which is exactly the lever a
 * character turnaround needs, and why no second model or custom node is required.
 */

/** Loader class per text-encoder family, derived from the installed file name. */
const ENCODER_TYPE_HINTS = [
  [/qwen_image|qwen_image_2/i, 'qwen_image'],
  [/qwen3vl|qwen_2\.5_vl|qwen_3_/i, 'qwen_image'],
  [/flux2/i, 'flux2'],
  [/t5xxl|clip_l/i, 'flux'],
  [/umt5|wan/i, 'wan'],
  [/ltx/i, 'ltxv'],
]

/** Guess the `CLIPLoader.type` enum for a text encoder file. */
export function encoderTypeFor(clipName, override) {
  if (override) return override
  for (const [pattern, type] of ENCODER_TYPE_HINTS) {
    if (pattern.test(String(clipName ?? ''))) return type
  }
  return 'qwen_image'
}

/**
 * Small helper that hands out stable node ids and wires links.
 */
export class GraphBuilder {
  constructor() {
    this.nodes = {}
    this.counter = 0
  }

  /** @param {string} classType */
  add(classType, inputs, label) {
    this.counter += 1
    const id = String(this.counter)
    const node = { class_type: classType, inputs }
    if (label) node._meta = { title: label }
    this.nodes[id] = node
    return id
  }

  /** A link reference: `[nodeId, outputSlot]`. */
  static ref(id, slot = 0) {
    return [id, slot]
  }

  build() {
    return this.nodes
  }
}

/** `TextEncodeQwenImage21.images` is a COMFY_AUTOGROW_V3 group naming image_1…image_16. */
export const MAX_REFERENCE_IMAGES = 16

/**
 * Character-view graph.
 *
 * Wiring, matching the official `image_qwen_image_2_1_t2i` / edit templates:
 *   UNETLoader -> [QwenImage21Cache] -> [Lightning LoRA] -> KSampler.model
 *   CLIPLoader + VAELoader + reference images -> TextEncodeQwenImage21
 *     outputs: 0 = positive CONDITIONING, 1 = negative CONDITIONING, 2 = LATENT
 *   EmptyLatentImage -> KSampler.latent_image
 *   KSampler -> VAEDecode -> SaveImage
 *
 * `latent_image` comes from an explicit EmptyLatentImage rather than the encoder's
 * LATENT output, because that is what the shipped template does and what the
 * reference-image path in this ComfyUI is verified against.
 *
 * @param {object} spec
 * @param {Record<string,string>} spec.models needs diffusionModel, textEncoder, vae
 * @param {string} spec.positive
 * @param {string} [spec.negative]
 * @param {number} spec.width
 * @param {number} spec.height
 * @param {number} [spec.seed]
 * @param {number} [spec.steps]
 * @param {number} [spec.cfg]
 * @param {string} [spec.samplerName]
 * @param {string} [spec.scheduler]
 * @param {boolean} [spec.turbo] apply the Lightning LoRA (draft only)
 * @param {number} [spec.turboStrength]
 * @param {string} [spec.filenamePrefix]
 * @param {boolean} [spec.hasCacheNode] set false on a ComfyUI without QwenImage21Cache
 * @param {string[]} [spec.referenceImages] input-dir file names, in priority order
 * @param {number} [spec.referenceResolution] sizing hint handed to the encoder
 * @param {string} [spec.encoderType] override the CLIPLoader type enum
 * @param {number} [spec.batchSize]
 * @returns {Record<string, object>} an API-format graph
 */
export function buildCharacterViewGraph(spec = {}) {
  const g = new GraphBuilder()
  const ref = GraphBuilder.ref
  const {
    models = {},
    positive = '',
    negative = '',
    width = 1024,
    height = 1280,
    seed = 0,
    steps = 25,
    cfg = 1,
    samplerName = 'euler',
    scheduler = 'simple',
    turbo = false,
    turboStrength = 1,
    filenamePrefix = 'characterviews/view',
    hasCacheNode = true,
    referenceImages = [],
    referenceResolution = 1024,
    encoderType,
    batchSize = 1,
  } = spec

  if (!models.diffusionModel) throw new Error('需要扩散模型：ComfyUI 里没有可用的 Qwen-Image 模型')
  if (!models.textEncoder) throw new Error('需要文本编码器：ComfyUI 里没有 qwen3vl 之类的 CLIP')
  if (!models.vae) throw new Error('需要 VAE：ComfyUI 里没有 qwen_image 系列的 VAE')

  const model = g.add('UNETLoader', { unet_name: models.diffusionModel, weight_dtype: 'default' }, 'UNETLoader')
  // Caches the immutable prefix across sampling steps — an optimisation only, so it
  // is skipped on a ComfyUI that does not ship the node.
  const cache = hasCacheNode
    ? g.add('QwenImage21Cache', { model: ref(model), device: 'auto', dtype: 'default' }, 'Qwen cache')
    : null

  const clip = g.add('CLIPLoader', {
    clip_name: models.textEncoder,
    type: encoderTypeFor(models.textEncoder, encoderType),
    device: 'default',
  }, 'CLIPLoader')
  const vae = g.add('VAELoader', { vae_name: models.vae }, 'VAELoader')

  let effectiveModel = cache ? ref(cache) : ref(model)
  if (turbo && models.lora) {
    const lora = g.add('LoraLoaderModelOnly', {
      model: effectiveModel,
      lora_name: models.lora,
      strength_model: turboStrength,
    }, 'Lightning LoRA')
    effectiveModel = ref(lora)
  }

  const encodeInputs = {
    clip: ref(clip),
    vae: ref(vae),
    prompt: positive,
    negative_prompt: negative,
    resolution: Number.isFinite(referenceResolution) ? referenceResolution : 1024,
  }
  // The reference photograph comes first: the encoder treats earlier images as the
  // stronger identity anchor, and the photo is the only ground truth here.
  const refs = (referenceImages ?? []).filter((f) => typeof f === 'string' && f).slice(0, MAX_REFERENCE_IMAGES)
  refs.forEach((file, index) => {
    encodeInputs[`images.image_${index + 1}`] = ref(g.add('LoadImage', { image: file }, `Reference ${index + 1}`))
  })
  const encode = g.add('TextEncodeQwenImage21', encodeInputs, 'TextEncodeQwenImage21')

  const latent = g.add('EmptyLatentImage', {
    width: Math.round(width / 32) * 32,
    height: Math.round(height / 32) * 32,
    batch_size: Math.max(1, Math.min(4, Math.round(batchSize))),
  }, 'Latent')

  const sampler = g.add('KSampler', {
    model: effectiveModel,
    seed,
    steps,
    cfg,
    sampler_name: samplerName,
    scheduler,
    positive: ref(encode, 0),
    negative: ref(encode, 1),
    latent_image: ref(latent),
    denoise: 1,
  }, 'KSampler')

  const decode = g.add('VAEDecode', { samples: ref(sampler), vae: ref(vae) }, 'VAEDecode')
  g.add('SaveImage', { images: ref(decode), filename_prefix: filenamePrefix }, 'SaveImage')

  return g.build()
}

// ---------------------------------------------------------------------------
// Upscaling
// ---------------------------------------------------------------------------

/** These networks are all 4x; any other factor is reached by resampling the 4x result. */
export const NATIVE_UPSCALE = 4

/** Node classes the upscale graph needs. */
export const UPSCALE_NODES = ['LoadImage', 'UpscaleModelLoader', 'ImageUpscaleWithModel', 'ImageScale', 'SaveImage']

/**
 * One image through an ESRGAN-family upscale model, resized to an exact target.
 *
 * Why the resize node is not optional decoration: the network is 4x and nothing else. A 1.5x or
 * 3.5x request cannot be asked of it, so the picture is taken to 4x — which is where all the
 * added detail comes from — and then resampled DOWN with lanczos to the requested size. The
 * detail survives a downscale; asking a resize node to invent it would not.
 *
 * The target is passed as an absolute size when the caller knows it, and as a ratio otherwise.
 * A ratio computed from the requested factor alone can drift a pixel on odd dimensions, and an
 * upscale whose output is one pixel off the number the panel promised is the kind of small lie
 * that makes people stop trusting the panel.
 *
 * @param {object} spec
 * @param {string} spec.image input-directory file name of the source
 * @param {string} spec.model installed upscale model file name
 * @param {number} spec.factor the requested multiplier (after clamping)
 * @param {number} [spec.targetWidth] exact output size; preferred when known
 * @param {number} [spec.targetHeight]
 * @param {string} [spec.filenamePrefix]
 * @returns {Record<string, object>} an API-format graph
 */
export function buildUpscaleGraph(spec = {}) {
  const g = new GraphBuilder()
  const ref = GraphBuilder.ref
  const {
    image,
    model,
    factor = 2,
    targetWidth = null,
    targetHeight = null,
    filenamePrefix = 'characterviews/upscale',
  } = spec

  if (!image) throw new Error('放大需要一张源图')
  if (!model) throw new Error('放大需要一个上采样模型，但 ComfyUI 里一个都没装')

  const source = g.add('LoadImage', { image }, 'Source')
  const loader = g.add('UpscaleModelLoader', { model_name: model }, 'Upscale model')
  const upscaled = g.add('ImageUpscaleWithModel', {
    upscale_model: ref(loader),
    image: ref(source),
  }, `Upscale ×${NATIVE_UPSCALE}`)

  // 4x is the network's own output, so a 4x request needs no resampling at all.
  if (Math.abs(Number(factor) - NATIVE_UPSCALE) < 1e-6) {
    g.add('SaveImage', { images: ref(upscaled), filename_prefix: filenamePrefix }, 'Save')
    return g.build()
  }

  const exact = Number.isFinite(Number(targetWidth)) && Number.isFinite(Number(targetHeight))
    && Number(targetWidth) > 0 && Number(targetHeight) > 0
  // `image` belongs in here with the sizing: building the parameter object separately and
  // forgetting the link is exactly the mistake this comment exists to prevent — the graph then
  // validates as "required input not set" only once it is actually submitted.
  const sizing = exact
    ? {
      image: ref(upscaled),
      upscale_method: 'lanczos',
      width: Math.round(Number(targetWidth)),
      height: Math.round(Number(targetHeight)),
      crop: 'disabled',
    }
    : {
      image: ref(upscaled),
      upscale_method: 'lanczos',
      scale_by: Math.round((Number(factor) / NATIVE_UPSCALE) * 10000) / 10000,
    }

  const resized = g.add('ImageScale', sizing, `Resize to ×${factor}`)
  g.add('SaveImage', { images: ref(resized), filename_prefix: filenamePrefix }, 'Save')
  return g.build()
}

/**
 * A compact description of a graph, for the UI's "what will be sent" disclosure.
 * Deliberately counts rather than dumps: the graph is ~10 nodes of plumbing.
 */
export function describeGraph(graph) {
  const nodes = Object.values(graph ?? {})
  const byClass = {}
  for (const node of nodes) byClass[node.class_type] = (byClass[node.class_type] ?? 0) + 1
  const encode = nodes.find((n) => n.class_type === 'TextEncodeQwenImage21')
  const refCount = Object.keys(encode?.inputs ?? {}).filter((k) => k.startsWith('images.image_')).length
  const latent = nodes.find((n) => n.class_type === 'EmptyLatentImage')
  const sampler = nodes.find((n) => n.class_type === 'KSampler')
  return {
    nodeCount: nodes.length,
    byClass,
    referenceCount: refCount,
    width: latent?.inputs?.width ?? null,
    height: latent?.inputs?.height ?? null,
    steps: sampler?.inputs?.steps ?? null,
    cfg: sampler?.inputs?.cfg ?? null,
    seed: sampler?.inputs?.seed ?? null,
  }
}

/**
 * Pre-flight a graph against the live server.
 *
 * Catches the two failures that otherwise only surface after queueing: a node class
 * this ComfyUI does not have (a missing custom node), and an enum widget naming a
 * model file that is not installed.
 *
 * @returns {Promise<{ok:boolean, errors:string[], warnings:string[]}>}
 */
export async function validateGraph(client, graph) {
  const errors = []
  const warnings = []
  const nodes = Object.entries(graph ?? {})
  if (nodes.length === 0) return { ok: false, errors: ['图里没有任何节点'], warnings }

  let info
  try {
    info = await client.objectInfo(undefined, { timeoutMs: 60000 })
  } catch (error) {
    return { ok: false, errors: [`读不到 ComfyUI 的节点清单：${error?.message ?? error}`], warnings }
  }

  for (const [id, node] of nodes) {
    const classType = node?.class_type
    const spec = info?.[classType]
    if (!spec) {
      errors.push(`节点 ${id}（${classType}）这个 ComfyUI 里没有 —— 多半是缺自定义节点`)
      continue
    }
    const inputs = node.inputs ?? {}
    for (const [group, table] of [['required', spec.input?.required ?? {}], ['optional', spec.input?.optional ?? {}]]) {
      for (const [name, definition] of Object.entries(table)) {
        const declared = Array.isArray(definition) ? definition[0] : undefined
        const isEnum = Array.isArray(declared)
        const value = inputs[name]
        const connected = Array.isArray(value)
        const isAutogrow = declared === 'COMFY_AUTOGROW_V3'
        const autogrowFilled = isAutogrow && Object.keys(inputs).some((k) => k.startsWith(`${name}.`))

        if (group === 'required' && value === undefined && !connected && !autogrowFilled && !isAutogrow) {
          errors.push(`节点 ${id}（${classType}）的必填项 "${name}" 没有赋值`)
          continue
        }
        if (value === undefined || connected) continue
        if (isEnum && typeof value === 'string' && !declared.includes(value)) {
          errors.push(`节点 ${id}（${classType}）的 "${name}" = "${value}" 不在已安装的 ${declared.length} 个选项里`)
        } else if (isEnum && declared.length === 0) {
          warnings.push(`节点 ${id}（${classType}）的 "${name}" 没有任何可选项`)
        }
      }
    }
  }
  return { ok: errors.length === 0, errors, warnings }
}

export default {
  buildCharacterViewGraph, buildUpscaleGraph, describeGraph, validateGraph,
  encoderTypeFor, GraphBuilder, MAX_REFERENCE_IMAGES, NATIVE_UPSCALE, UPSCALE_NODES,
}
