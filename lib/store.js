/**
 * The character library: what characters exist and which images belong to them.
 *
 * Split deliberately in two:
 *
 *  - `library.json` keeps the INDEX — characters, their photos, their renders, and
 *    the batch each render came from. Small, readable, safe to rewrite wholesale.
 *  - the bytes live in `characters/<character>/photos|views/<id>.<ext>`, written once
 *    and never rewritten, so an image URL stays valid forever and a crash mid-save
 *    cannot corrupt an image that already exists.
 *
 * Writes are serialised through one promise chain. Two renders finishing at the same
 * instant would otherwise both read the index, both add their asset, and the second
 * write would silently drop the first one's entry — the file would be on disk with
 * nothing pointing at it.
 */
import { mkdir, readFile, writeFile, rename, rm, stat, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { charactersDir, characterDir, storePath, safeSegment } from './config.js'
import { assetFilePath } from './paths.js'
import { moveToTrash } from './trash.js'

/** @typedef {{id:string, kind:'photo'|'view', ext:string, label:string, viewpoint:string|null, createdAt:string, bytes:number, file:string, comfy?:object|null, runId?:string|null, batchId?:string|null}} Asset */
/** @typedef {{id:string, name:string, notes:string, createdAt:string, updatedAt:string, assets:Record<string, Asset>, batches:object[], lastRunId:string|null}} Character */

const EMPTY = { version: 1, characters: {}, order: [] }

function newId(prefix) {
  return `${prefix}-${globalThis.crypto.randomUUID().slice(0, 10)}`
}

/** Guess a file extension from a filename or content type. */
export function guessExt(filename, contentType) {
  const fromName = String(filename ?? '').toLowerCase().match(/\.([a-z0-9]{2,5})$/)
  if (fromName) return fromName[1] === 'jpeg' ? 'jpg' : fromName[1]
  const type = String(contentType ?? '').split(';')[0].trim()
  return { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/bmp': 'bmp', 'image/gif': 'gif' }[type] ?? 'png'
}

export function mediaTypeFor(ext) {
  const e = String(ext ?? '').toLowerCase()
  if (e === 'jpg' || e === 'jpeg') return 'image/jpeg'
  if (e === 'webp') return 'image/webp'
  if (e === 'bmp') return 'image/bmp'
  if (e === 'gif') return 'image/gif'
  return 'image/png'
}

/**
 * @param {object} [options]
 * @param {object} [options.initial] index loaded from a previous process
 */
export function createStore(options = {}) {
  /** @type {{version:number, characters:Record<string,Character>, order:string[]}} */
  let index = normaliseIndex(options.initial)
  /** @type {Promise<unknown>} */
  let chain = Promise.resolve()

  /** Serialise every mutation, so concurrent renders cannot lose each other's writes. */
  function queue(task) {
    const next = chain.then(task, task)
    // Keep the chain alive after a failure; the failure itself is the caller's.
    chain = next.catch(() => {})
    return next
  }

  async function persist() {
    const target = storePath()
    await mkdir(dirname(target), { recursive: true })
    const temp = `${target}.${process.pid}.tmp`
    await writeFile(temp, `${JSON.stringify(index, null, 2)}\n`, 'utf8')
    await rename(temp, target)
  }

  /** Absolute path of one asset's bytes. Ids come from this module, never a request. */
  function assetPath(character, asset) {
    return assetFilePath(character, asset)
  }

  return {
    /** Every character, newest first. */
    list() {
      return index.order
        .map((id) => index.characters[id])
        .filter(Boolean)
        .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
        .map((c) => ({
          id: c.id,
          name: c.name,
          notes: c.notes,
          createdAt: c.createdAt,
          updatedAt: c.updatedAt,
          photoCount: Object.values(c.assets).filter((a) => a.kind === 'photo').length,
          viewCount: Object.values(c.assets).filter((a) => a.kind === 'view').length,
          coverAssetId: coverOf(c),
          lastRunId: c.lastRunId ?? null,
        }))
    },

    get(id) {
      return index.characters[String(id ?? '')] ?? null
    },

    /** A character with a display name that is unique enough to name a folder. */
    create(input = {}) {
      return queue(async () => {
        const now = new Date().toISOString()
        const name = String(input.name ?? '').trim() || `角色 ${index.order.length + 1}`
        const character = {
          id: newId('char'),
          // The display name is what the user sees; the FOLDER is derived from it and
          // disambiguated, so two characters called "小明" do not share a directory.
          name: uniqueName(name),
          notes: String(input.notes ?? '').slice(0, 2000),
          createdAt: now,
          updatedAt: now,
          assets: {},
          batches: [],
          lastRunId: null,
        }
        index.characters[character.id] = character
        index.order.push(character.id)
        await mkdir(characterDir(character.name), { recursive: true })
        await persist()
        return character
      })
    },

    update(id, patch = {}) {
      return queue(async () => {
        const character = index.characters[String(id ?? '')]
        if (!character) return null
        if (typeof patch.name === 'string' && patch.name.trim() && patch.name.trim() !== character.name) {
          const previous = character.name
          character.name = uniqueName(patch.name.trim(), character.id)
          // Move the directory rather than orphaning the images in the old one.
          try {
            await rename(characterDir(previous), characterDir(character.name))
          } catch {
            await mkdir(characterDir(character.name), { recursive: true })
          }
        }
        if (typeof patch.notes === 'string') character.notes = patch.notes.slice(0, 2000)
        if (patch.lastRunId !== undefined) character.lastRunId = patch.lastRunId
        character.updatedAt = new Date().toISOString()
        await persist()
        return character
      })
    },

    /**
     * Remove a character, photos included.
     *
     * The generated views are erased with the folder — they are reproducible, and
     * ComfyUI keeps its own copies. The PHOTOS are moved to the recycle bin first, so
     * deleting a character is not a way to lose the only copy of somebody's picture by
     * accident. Whatever the bin could not take is left on disk rather than removed.
     */
    remove(id) {
      return queue(async () => {
        const character = index.characters[String(id ?? '')]
        if (!character) return { ok: false }

        const photos = Object.values(character.assets).filter((a) => a.kind === 'photo')
        let trashed = 0
        let kept = 0
        for (const photo of photos) {
          const moved = await moveToTrash(character, photo)
          if (moved) trashed += 1
          else kept += 1
        }

        delete index.characters[character.id]
        index.order = index.order.filter((x) => x !== character.id)
        await persist()

        const dir = characterDir(character.name)
        if (kept > 0) {
          // Something could not be moved, so the folder is emptied rather than deleted:
          // `recursive: true` on the folder would take those bytes with it.
          for (const asset of Object.values(character.assets)) {
            if (asset.kind === 'photo') continue
            try { await rm(assetPath(character, asset), { force: true }) } catch { /* already gone */ }
          }
        } else {
          try {
            await rm(dir, { recursive: true, force: true })
          } catch { /* a folder already gone is the desired state */ }
        }

        return { ok: true, trashedPhotos: trashed, keptPhotos: kept, keptDir: kept > 0 ? dir : null }
      })
    },

    /**
     * Store bytes and record them against a character.
     *
     * @param {string} characterId
     * @param {object} meta {kind, ext, label, viewpoint, comfy, runId, batchId}
     * @param {Uint8Array} bytes
     */
    writeAsset(characterId, meta, bytes) {
      return queue(async () => {
        const character = index.characters[String(characterId ?? '')]
        if (!character) return null
        const asset = {
          id: newId(meta.kind === 'photo' ? 'photo' : 'view'),
          kind: meta.kind === 'photo' ? 'photo' : 'view',
          ext: String(meta.ext ?? 'png'),
          label: String(meta.label ?? '').slice(0, 160),
          viewpoint: meta.viewpoint ?? null,
          createdAt: new Date().toISOString(),
          bytes: bytes.byteLength,
          comfy: meta.comfy ?? null,
          runId: meta.runId ?? null,
          batchId: meta.batchId ?? null,
          // Provenance for an upscaled picture: which asset it came from and by how much. Stored
          // on the asset rather than in the batch list because it describes THIS image, and the
          // gallery shows it per thumbnail.
          source: meta.source ?? null,
        }
        asset.file = assetPath(character, asset)
        await mkdir(dirname(asset.file), { recursive: true })
        await writeFile(asset.file, bytes)
        character.assets[asset.id] = asset
        character.updatedAt = asset.createdAt
        await persist()
        return asset
      })
    },

    /**
     * Remove one asset from the character.
     *
     * What happens to the BYTES depends on what they are, and that is the whole point:
     *
     *  - `view`  — erased. A generated image is reproducible from the batch record's seed
     *              and prompt, and ComfyUI keeps its own copy in its output directory, so
     *              deleting the archived copy is space management rather than loss.
     *  - `photo` — moved to the recycle bin by default. A photograph the user supplied is
     *              reproducible by nothing, so erasing it is not this plugin's decision to
     *              make. `purge: true` is the explicit "no really, erase it" path.
     *
     * @param {object} [options]
     * @param {boolean} [options.purge] delete a photo's bytes outright instead of trashing
     * @returns {Promise<{ok:boolean, kind?:string, trashed?:boolean, entryId?:string, freedBytes?:number}>}
     */
    removeAsset(characterId, assetId, options = {}) {
      return queue(async () => {
        const character = index.characters[String(characterId ?? '')]
        const asset = character?.assets?.[String(assetId ?? '')]
        if (!character || !asset) return { ok: false }

        const path = assetPath(character, asset)
        const size = Number(asset.bytes) || 0
        let trashed = false
        let entryId = null
        let leftOnDisk = null

        if (asset.kind === 'photo' && options.purge !== true) {
          const moved = await moveToTrash(character, asset)
          trashed = Boolean(moved)
          entryId = moved?.id ?? null
          // The bin failing must not quietly become an erase: that would invert the whole
          // point of having one. The entry goes, the bytes stay, and the caller is told
          // where they are so the user is not left wondering what happened.
          if (!moved) leftOnDisk = path
        } else {
          try {
            await rm(path, { force: true })
          } catch { /* a missing file is already the desired state */ }
        }

        delete character.assets[asset.id]
        character.updatedAt = new Date().toISOString()
        await persist()
        return {
          ok: true,
          kind: asset.kind,
          trashed,
          entryId,
          leftOnDisk,
          freedBytes: trashed ? 0 : size,
        }
      })
    },

    /**
     * Put a photo back into a character's library after the recycle bin returns it.
     *
     * The bytes coming back is only half a restore. The asset was removed from the index
     * when it was deleted, and a file that no index entry points at is invisible to the
     * panel — so "restored" would mean "sitting in the folder, unusable". Both halves have
     * to move together, which is why this lives here and not in the caller.
     *
     * @param {object} record {characterId, characterName, assetId, ext, label, size, viewpoint}
     */
    restoreAsset(record) {
      return queue(async () => {
        const character = index.characters[String(record?.characterId ?? '')]
        if (!character) return { ok: false, error: { code: 'no-character', message: '原来的角色已经不在了' } }
        const asset = {
          id: String(record.assetId),
          kind: 'photo',
          ext: String(record.ext ?? 'png'),
          label: String(record.label ?? '恢复的照片').slice(0, 160),
          viewpoint: null,
          createdAt: new Date().toISOString(),
          restoredAt: new Date().toISOString(),
          bytes: Number(record.size) || 0,
          comfy: null,
          runId: null,
          batchId: null,
        }
        asset.file = assetPath(character, asset)
        character.assets[asset.id] = asset
        character.updatedAt = asset.createdAt
        await persist()
        return { ok: true, asset }
      })
    },

    /** Record a batch of renders so the panel can show what one request produced. */
    addBatch(characterId, batch) {
      return queue(async () => {
        const character = index.characters[String(characterId ?? '')]
        if (!character) return null
        character.batches.unshift(batch)
        // The batch list is a convenience view; the assets are the record.
        if (character.batches.length > 30) character.batches.length = 30
        character.updatedAt = new Date().toISOString()
        await persist()
        return batch
      })
    },

    /** Absolute path for an asset id: the only way a path reaches the file manager. */
    pathFor(characterId, assetId) {
      const character = index.characters[String(characterId ?? '')]
      const asset = character?.assets?.[String(assetId ?? '')]
      return character && asset ? asset.file : null
    },

    /** A character's own folder, created on demand so "open location" works before the first render. */
    async dirFor(characterId) {
      const character = index.characters[String(characterId ?? '')]
      if (!character) return null
      const dir = characterDir(character.name)
      await mkdir(dir, { recursive: true })
      return dir
    },

    async readAsset(characterId, assetId) {
      const path = this.pathFor(characterId, assetId)
      if (!path) return null
      try {
        return { bytes: await readFile(path), asset: index.characters[String(characterId)].assets[String(assetId)] }
      } catch {
        return null
      }
    },

    /** The current index, for backup/export or the agent tools. */
    snapshot() {
      return JSON.parse(JSON.stringify(index))
    },
  }

  // -- helpers -------------------------------------------------------------

  function coverOf(character) {
    const views = Object.values(character.assets).filter((a) => a.kind === 'view')
    if (views.length > 0) return views[views.length - 1].id
    const photos = Object.values(character.assets).filter((a) => a.kind === 'photo')
    return photos.length > 0 ? photos[photos.length - 1].id : null
  }

  /** Keep display names unique so no two characters resolve to the same folder. */
  function uniqueName(name, selfId = null) {
    const taken = new Set(index.order
      .filter((id) => id !== selfId)
      .map((id) => index.characters[id]?.name)
      .filter(Boolean))
    if (!taken.has(name)) return name
    for (let n = 2; n < 500; n += 1) {
      const candidate = `${name} ${n}`
      if (!taken.has(candidate)) return candidate
    }
    return `${name} ${Date.now().toString(36)}`
  }
}

function normaliseIndex(raw) {
  if (!raw || typeof raw !== 'object' || !raw.characters || typeof raw.characters !== 'object') return { ...EMPTY, characters: {}, order: [] }
  const characters = {}
  const order = []
  for (const [id, value] of Object.entries(raw.characters)) {
    if (!value || typeof value !== 'object') continue
    const name = typeof value.name === 'string' && value.name.trim() ? value.name : safeSegment(id)
    characters[id] = {
      id,
      name,
      notes: typeof value.notes === 'string' ? value.notes : '',
      createdAt: value.createdAt ?? new Date().toISOString(),
      updatedAt: value.updatedAt ?? value.createdAt ?? new Date().toISOString(),
      assets: value.assets && typeof value.assets === 'object' ? value.assets : {},
      batches: Array.isArray(value.batches) ? value.batches : [],
      lastRunId: value.lastRunId ?? null,
    }
    order.push(id)
  }
  return { version: 1, characters, order }
}

/** Load the index from disk, tolerating a corrupt file by starting empty. */
export async function loadIndex() {
  try {
    return normaliseIndex(JSON.parse(await readFile(storePath(), 'utf8')))
  } catch {
    return { ...EMPTY, characters: {}, order: [] }
  }
}

/** Total bytes the library occupies, for the settings page. */
export async function librarySize() {
  let total = 0
  async function walk(dir) {
    let entries = []
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else {
        try {
          total += (await stat(full)).size
        } catch { /* a file removed mid-walk simply does not count */ }
      }
    }
  }
  await walk(charactersDir())
  return total
}

export default { createStore, loadIndex, librarySize, guessExt, mediaTypeFor }
