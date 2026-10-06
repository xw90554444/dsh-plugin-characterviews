/**
 * Plugin configuration: load, validate, persist.
 *
 * Stored as JSON under the DSH home directory rather than inside the installed
 * package, so reinstalling or upgrading the plugin never destroys user settings.
 */
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
// Pure module, no I/O: safe to depend on, and it keeps the set of valid aspect keys and
// edge lengths defined in exactly one place — the same place that owns the geometry.
import { ASPECTS, EDGES } from './angles.js'

const ASPECT_KEYS = Object.keys(ASPECTS)

/** `DSH_HOME` is set by the harness; the fallbacks only matter outside it. */
export function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim()) return fromEnv.trim()
  return join(homedir(), '.dsh')
}

export function pluginRootDir() {
  return join(dshHome(), 'characterviews')
}

export function configPath() {
  return join(pluginRootDir(), 'config.json')
}

/** One folder per character, holding that character's photos and renders. */
export function charactersDir() {
  return join(pluginRootDir(), 'characters')
}

export function characterDir(id) {
  return join(charactersDir(), safeSegment(id))
}

export function storePath() {
  return join(pluginRootDir(), 'library.json')
}

/**
 * The plugin's own recycle bin.
 *
 * Source photos go here instead of being erased: a generated view can be reproduced from
 * its recorded seed and prompt, a photograph somebody supplied cannot.
 */
export function trashDir() {
  return join(pluginRootDir(), 'trash')
}

export function trashIndexPath() {
  return join(trashDir(), 'trash.json')
}

/**
 * A directory name derived from a user-visible label.
 *
 * This is a filesystem path built from free text, so it is sanitised rather than
 * trusted: separators, traversal and Windows-reserved characters all go, and an
 * empty result falls back to a fixed name instead of yielding the parent folder.
 */
export function safeSegment(label) {
  const cleaned = String(label ?? '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/^\.+/, '_')
    .replace(/[. ]+$/, '')
    .trim()
    .slice(0, 48)
  // `CON`, `NUL`, `COM1`… are device names on Windows and cannot be a folder.
  if (!cleaned || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(cleaned)) return `character-${Date.now().toString(36)}`
  return cleaned
}

export const DEFAULT_CONFIG = Object.freeze({
  comfy: {
    baseUrl: 'http://127.0.0.1:8188',
    /**
     * Output size of ONE view.
     *
     * `edge` is that view's LONG edge; `aspect` picks the shape. Stored as a pair rather
     * than a megapixel budget because this is the knob people actually reason with — "I
     * want 1024" is a request, "1.3 MP" is an implementation detail that lands on 992×1312.
     *
     * For a multi-view sheet this describes each view, and the canvas is the grid that
     * holds them: the geometry and its caps live in `angles.js#canvasFor`.
     */
    resolution: {
      aspect: 'portrait',
      edge: 1024,
    },
    /**
     * Legacy budget, kept only so an older config does not lose the user's intent: when a
     * stored config has no `resolution`, the closest edge to this budget is adopted once.
     */
    megapixels: null,
    /** 'standard' (25 steps) is the shipped template's default and the sane one. */
    preset: 'standard',
    /** Explicit model overrides; null means "auto-resolve from what is installed". */
    models: {
      diffusionModel: null,
      textEncoder: null,
      vae: null,
      lora: null,
    },
    /** Reference-image sizing hint handed to TextEncodeQwenImage21 (0 = keep native). */
    referenceResolution: 1024,
    /** Where renders are copied. Null = `<DSH_HOME>/characterviews/characters`. */
    outputDir: null,
    /** Also keep a copy in ComfyUI's own output directory (its SaveImage always does). */
    keepComfyCopy: true,
  },
  prompt: {
    /** Appended to every positive prompt; the place for a house style. */
    styleSuffix: 'photorealistic, natural color, sharp focus, high detail',
    /** Appended to every negative prompt. */
    negativeSuffix: 'extra limbs, extra fingers, deformed hands, distorted face, text, watermark, signature, jpeg artifacts, blurry',
    /** Prefer a clean neutral backdrop so the views read as a turnaround. */
    background: 'plain seamless light grey studio background, even soft lighting, no props',
  },
  ui: {
    activeCharacterId: null,
    lastMode: 'three',
    sheetLayout: 'sheet',
    /**
     * Height of the task list in the panel, in pixels.
     *
     * Persisted because it is a preference about the user's screen, not about a render:
     * a queue of long jobs is worth a lot of room to one person and almost none to another.
     */
    taskPanelHeight: 220,
    /** Height of the gallery, for the same reason: it must not grow with the render count. */
    libraryPanelHeight: 260,
    /**
     * Whether the gallery should keep sizing itself to exactly one row of thumbnails.
     *
     * A fitted height is NOT a constant: a cell is `max(140px, panelWidth / columns)` wide and
     * 4/3 of that tall, so the right height changes with the window. Storing a measured number
     * and treating it as the answer is precisely what makes a gallery look wrong after a
     * resize, so the MODE is stored and the number derived from it — until the user drags the
     * handle, which is a deliberate choice of a fixed height and switches this off.
     */
    libraryAutoFit: true,
  },
})

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Shallow-per-section merge that keeps unknown keys out and fills every default. */
export function mergeConfig(base, patch) {
  const out = {}
  for (const [key, value] of Object.entries(base)) {
    if (isPlainObject(value)) out[key] = mergeConfig(value, isPlainObject(patch?.[key]) ? patch[key] : {})
    else out[key] = patch && key in patch ? patch[key] : value
  }
  return out
}

/**
 * Coerce anything read from disk into a usable config.
 * A corrupt or hand-edited file must not brick the plugin, so bad fields fall
 * back to defaults instead of throwing.
 */
export function normaliseConfig(raw) {
  const merged = mergeConfig(DEFAULT_CONFIG, isPlainObject(raw) ? raw : {})
  const comfy = merged.comfy
  const baseUrl = typeof comfy.baseUrl === 'string' && comfy.baseUrl.trim()
    ? comfy.baseUrl.trim().replace(/\/+$/, '')
    : DEFAULT_CONFIG.comfy.baseUrl
  const preset = ['draft', 'standard', 'quality'].includes(comfy.preset) ? comfy.preset : 'standard'
  const referenceResolution = Number.isFinite(Number(comfy.referenceResolution))
    ? Math.min(4096, Math.max(0, Math.round(Number(comfy.referenceResolution) / 32) * 32))
    : DEFAULT_CONFIG.comfy.referenceResolution
  const outputDir = typeof comfy.outputDir === 'string' && comfy.outputDir.trim() ? comfy.outputDir.trim() : null
  const models = {}
  for (const key of Object.keys(DEFAULT_CONFIG.comfy.models)) {
    const value = comfy.models?.[key]
    models[key] = typeof value === 'string' && value.trim() ? value.trim() : null
  }

  // Resolution, with a one-time migration from the old megapixel budget.
  //
  // A config written before this field existed carries `megapixels` and no `resolution`.
  // Adopting the nearest offered edge keeps the picture about the size the user had already
  // chosen, instead of silently resetting them to the default.
  //
  // The long edge is recovered as `sqrt(area × ratio)` rather than `sqrt(area)`: the budget
  // was an AREA, and taking its square root describes a square, which understates the long
  // edge of the portrait frame that path actually produced (2.5 MP came out as 1024 instead
  // of 1536). The old render path was portrait for every single-view case, so portrait is
  // the right assumption to invert it with.
  const storedEdge = Number(comfy.resolution?.edge)
  let edge = EDGES.includes(storedEdge) ? storedEdge : null
  if (edge === null) {
    const legacy = Number(comfy.megapixels)
    if (Number.isFinite(legacy) && legacy > 0) {
      const legacyAspect = ASPECTS.portrait.height / ASPECTS.portrait.width
      const approximate = Math.sqrt(legacy * 1_000_000 * legacyAspect)
      edge = EDGES.reduce((best, candidate) => (
        Math.abs(candidate - approximate) < Math.abs(best - approximate) ? candidate : best
      ), EDGES[0])
    } else {
      edge = DEFAULT_CONFIG.comfy.resolution.edge
    }
  }
  const aspect = ASPECT_KEYS.includes(comfy.resolution?.aspect)
    ? comfy.resolution.aspect
    : DEFAULT_CONFIG.comfy.resolution.aspect

  const prompt = {}
  for (const key of ['styleSuffix', 'negativeSuffix', 'background']) {
    const value = merged.prompt?.[key]
    prompt[key] = typeof value === 'string' ? value : DEFAULT_CONFIG.prompt[key]
  }
  const lastMode = ['single', 'three', 'multi', 'custom'].includes(merged.ui?.lastMode) ? merged.ui.lastMode : 'three'
  const sheetLayout = merged.ui?.sheetLayout === 'separate' ? 'separate' : 'sheet'
  // Clamped to the same range the drag handle enforces, so a hand-edited config file
  // cannot produce a task list taller than the panel or squeezed to nothing.
  const taskPanelHeight = Number.isFinite(Number(merged.ui?.taskPanelHeight))
    ? Math.max(120, Math.min(720, Math.round(Number(merged.ui.taskPanelHeight))))
    : DEFAULT_CONFIG.ui.taskPanelHeight
  const libraryPanelHeight = Number.isFinite(Number(merged.ui?.libraryPanelHeight))
    ? Math.max(120, Math.min(720, Math.round(Number(merged.ui.libraryPanelHeight))))
    : DEFAULT_CONFIG.ui.libraryPanelHeight
  return {
    comfy: {
      baseUrl,
      resolution: { aspect, edge },
      preset,
      models,
      referenceResolution,
      outputDir,
      keepComfyCopy: comfy.keepComfyCopy !== false,
    },
    prompt,
    ui: {
      activeCharacterId: typeof merged.ui?.activeCharacterId === 'string' ? merged.ui.activeCharacterId : null,
      lastMode,
      sheetLayout,
      taskPanelHeight,
      libraryPanelHeight,
      libraryAutoFit: merged.ui?.libraryAutoFit !== false,
    },
  }
}

export async function readConfig() {
  try {
    return normaliseConfig(JSON.parse(await readFile(configPath(), 'utf8')))
  } catch {
    return normaliseConfig(null)
  }
}

/** Write via a temp file + rename so a crash mid-write cannot truncate the config. */
export async function writeConfig(config) {
  const normalised = normaliseConfig(config)
  const target = configPath()
  await mkdir(dirname(target), { recursive: true })
  const temp = `${target}.${process.pid}.tmp`
  await writeFile(temp, `${JSON.stringify(normalised, null, 2)}\n`, 'utf8')
  await rename(temp, target)
  return normalised
}

/** Apply a partial patch and persist. */
export async function patchConfig(patch) {
  return writeConfig(mergeConfig(await readConfig(), patch ?? {}))
}

export default {
  dshHome, pluginRootDir, configPath, charactersDir, characterDir, storePath, trashDir, trashIndexPath, safeSegment,
  DEFAULT_CONFIG, mergeConfig, normaliseConfig, readConfig, writeConfig, patchConfig,
}
