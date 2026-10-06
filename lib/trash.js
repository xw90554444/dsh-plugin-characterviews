/**
 * The plugin's own recycle bin, for source photos only.
 *
 * Why this exists at all: the two kinds of file in this plugin are not alike. A
 * generated view is reproducible — the batch record holds its seed, prompt, angles and
 * step count, and ComfyUI keeps its own copy in its output directory. A photograph the
 * user supplied is not reproducible by anything, so a hard delete of one is a decision
 * this plugin has no business making on their behalf.
 *
 * So: generated views are still deleted outright (that is space management), and photos
 * are moved here, where they stay until the user empties the bin. The cost is disk space
 * the user can see and reclaim; the benefit is that a misclick is recoverable.
 *
 * Layout:
 *   trash/<entryId>.<ext>     the bytes, byte-for-byte
 *   trash.json                what each entry was attached to, and where it came from
 */
import { mkdir, readFile, writeFile, rename, rm, copyFile, stat, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { trashDir, trashIndexPath, characterDir } from './config.js'
import { assetFilePath } from './paths.js'

const EMPTY = { version: 1, entries: [] }

/**
 * A collision-proof destination name.
 *
 * The original name cannot be reused: `photos/photo-ab12.png` and a later
 * `photos/photo-ab12.png` are different files, and keeping the id would make the second
 * deletion overwrite the first one's bytes.
 */
function entryFileName(asset) {
  const ext = String(asset?.ext ?? 'png').replace(/[^a-z0-9]/gi, '') || 'png'
  return `${asset.id}-${globalThis.crypto.randomUUID().slice(0, 6)}.${ext}`
}

async function readIndex() {
  try {
    const parsed = JSON.parse(await readFile(trashIndexPath(), 'utf8'))
    return Array.isArray(parsed?.entries) ? parsed : { ...EMPTY, entries: [] }
  } catch {
    return { ...EMPTY, entries: [] }
  }
}

async function writeIndex(index) {
  const target = trashIndexPath()
  await mkdir(dirname(target), { recursive: true })
  const temp = `${target}.${process.pid}.tmp`
  await writeFile(temp, `${JSON.stringify(index, null, 2)}\n`, 'utf8')
  await rename(temp, target)
}

/**
 * Move one asset's bytes into the bin and record where they came from.
 *
 * `rename` first because it is instant when the two paths share a volume, which they
 * always do here. A cross-volume or locked file falls back to a copy followed by a
 * removal, so the operation still succeeds rather than failing on a technicality.
 *
 * @returns {Promise<{id:string, fileName:string, size:number}|null>}
 */
export async function moveToTrash(character, asset) {
  const source = assetFilePath(character, asset)
  const fileName = entryFileName(asset)
  const destination = join(trashDir(), fileName)
  await mkdir(trashDir(), { recursive: true })

  let size = 0
  try { size = (await stat(source)).size } catch { return null }

  try {
    await rename(source, destination)
  } catch {
    try {
      await copyFile(source, destination)
      await rm(source, { force: true })
    } catch {
      return null
    }
  }

  const entry = {
    id: `trash-${globalThis.crypto.randomUUID().slice(0, 10)}`,
    fileName,
    originalName: asset.label ?? null,
    ext: asset.ext ?? 'png',
    size,
    characterId: character.id,
    characterName: character.name,
    assetId: asset.id,
    viewLabel: asset.viewpoint ?? null,
    deletedAt: new Date().toISOString(),
  }
  const index = await readIndex()
  index.entries.unshift(entry)
  await writeIndex(index)
  return { id: entry.id, fileName, size }
}

/** Newest first, with the total the panel shows. */
export async function listTrash() {
  const index = await readIndex()
  // Entries whose bytes were removed by hand are dropped from the listing rather than
  // offered as a restore that cannot work.
  const alive = []
  for (const entry of index.entries) {
    try {
      await stat(join(trashDir(), entry.fileName))
      alive.push(entry)
    } catch { /* gone from disk; do not advertise it */ }
  }
  if (alive.length !== index.entries.length) {
    index.entries = alive
    await writeIndex(index)
  }
  const totalBytes = alive.reduce((sum, e) => sum + (Number(e.size) || 0), 0)
  return { entries: alive, totalBytes }
}

export async function trashBytes() {
  const { totalBytes } = await listTrash()
  return totalBytes
}

/**
 * Put a photo back where it was.
 *
 * Two halves, and both are required: the bytes move back, and the library index gets its
 * entry again. A file that no index entry points at is invisible to the panel, so moving
 * the bytes alone would report success while leaving the user with a photo they cannot
 * see or use.
 *
 * The character folder is recreated if needed, because restoring is exactly the case where
 * the user deleted the whole character and then changed their mind.
 *
 * @param {string} entryId
 * @param {object} [hooks]
 * @param {(record:object) => Promise<{ok:boolean, error?:object}>} [hooks.restoreRecord]
 *   re-registers the asset; supplied by the API so the trash never imports the store.
 */
export async function restoreFromTrash(entryId, hooks = {}) {
  const index = await readIndex()
  const entry = index.entries.find((e) => e.id === entryId)
  if (!entry) return { ok: false, error: { code: 'not-found', message: '回收站里没有这一项' } }

  const source = join(trashDir(), entry.fileName)
  try {
    await stat(source)
  } catch {
    return { ok: false, error: { code: 'missing', message: '文件已经不在回收站里了' } }
  }

  // The index is consulted BEFORE the bytes move: if the character is gone and the caller
  // cannot re-register the asset, the file should stay in the bin rather than be dropped
  // into a folder that nothing reads.
  if (typeof hooks.restoreRecord === 'function') {
    const registered = await hooks.restoreRecord(entry)
    if (!registered?.ok) {
      return { ok: false, error: registered?.error ?? { code: 'restore-failed', message: '无法把这个资源记回角色' } }
    }
  }

  const target = assetFilePath({ name: entry.characterName }, { id: entry.assetId, kind: 'photo', ext: entry.ext })
  await mkdir(dirname(target), { recursive: true })
  try {
    await rename(source, target)
  } catch {
    try {
      await copyFile(source, target)
      await rm(source, { force: true })
    } catch (error) {
      return { ok: false, error: { code: 'restore-failed', message: String(error?.message ?? error) } }
    }
  }

  index.entries = index.entries.filter((e) => e.id !== entryId)
  await writeIndex(index)
  return { ok: true, restored: { path: target, characterId: entry.characterId, assetId: entry.assetId } }
}

/** Remove one entry for good. */
export async function deleteTrashEntry(entryId) {
  const index = await readIndex()
  const entry = index.entries.find((e) => e.id === entryId)
  if (!entry) return { ok: false, error: { code: 'not-found', message: '回收站里没有这一项' } }
  try {
    await rm(join(trashDir(), entry.fileName), { force: true })
  } catch { /* a missing file is already the desired state */ }
  index.entries = index.entries.filter((e) => e.id !== entryId)
  await writeIndex(index)
  return { ok: true }
}

/** Empty the bin. Returns how much was reclaimed, so the panel can say so. */
export async function emptyTrash() {
  const { entries, totalBytes } = await listTrash()
  for (const entry of entries) {
    try {
      await rm(join(trashDir(), entry.fileName), { force: true })
    } catch { /* keep going: one locked file must not strand the rest */ }
  }
  // Rewritten rather than deleted: an empty index file is more useful than a missing one,
  // and a later restore then fails with "没有这一项" instead of a parse error.
  await writeIndex({ ...EMPTY, entries: [] })
  return { ok: true, removed: entries.length, freedBytes: totalBytes }
}

/** Bytes under the bin, walked from disk — used by the settings footer. */
export async function trashSizeOnDisk() {
  let total = 0
  let entries = []
  try {
    entries = await readdir(trashDir(), { withFileTypes: true })
  } catch {
    return 0
  }
  for (const item of entries) {
    if (!item.isFile()) continue
    try {
      total += (await stat(join(trashDir(), item.name))).size
    } catch { /* removed mid-walk */ }
  }
  return total
}

export { trashDir, trashIndexPath, characterDir }
export default {
  moveToTrash, listTrash, restoreFromTrash, deleteTrashEntry, emptyTrash,
  trashBytes, trashSizeOnDisk,
}
