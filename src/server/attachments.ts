import {
    existsSync,
    mkdirSync,
    readdirSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs"
import { basename, extname, join, resolve, sep } from "node:path"
import { workspace } from "../config/paths"
import type { TaskAttachment } from "../shared/types"

/**
 * Screenshots and other files attached to a task.
 *
 * Unlike a note, a task has no file of its own to sit beside — it is a database
 * row — so these live in their own tree: one folder per task ref, under the
 * workspace's data directory, next to the SQLite file that owns everything else
 * about the task.
 *
 * The point of storing these on disk rather than as a DB blob is the same
 * reason notes attachments are files: an agent working the task already has
 * filesystem tools, so handing it an absolute path is enough for it to look at
 * a screenshot without this app being in the loop at all.
 */

const IMAGE_EXTENSIONS = new Set([
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".svg",
    ".avif",
    ".bmp",
])

function attachmentsRoot(): string {
    return join(workspace().tasksDir, "data", "attachments")
}

function taskFolder(ref: string): string {
    return join(attachmentsRoot(), ref.toLowerCase())
}

function isImageFile(name: string): boolean {
    return IMAGE_EXTENSIONS.has(extname(name).toLowerCase())
}

/** Strip a client-supplied filename down to a basename that is safe to write. */
function safeFilename(name: string): string {
    const base = basename(String(name).replace(/\\/g, "/")).trim()
    const cleaned = base
        .replace(/[^A-Za-z0-9._ -]+/g, "-")
        .replace(/^[.\-]+/, "")
        .slice(0, 120)
    return cleaned || `file-${Date.now()}`
}

/** Add `-2`, `-3`… until the name is free, so a second `screenshot.png` never
 *  overwrites the first. */
function uniqueName(folder: string, candidate: string): string {
    if (!existsSync(join(folder, candidate))) return candidate

    const extension = extname(candidate)
    const stem = candidate.slice(0, candidate.length - extension.length)
    for (let index = 2; index < 1000; index += 1) {
        const next = `${stem}-${index}${extension}`
        if (!existsSync(join(folder, next))) return next
    }
    throw new Error(`Could not find a free filename near '${candidate}'.`)
}

function describe(ref: string, name: string): TaskAttachment {
    const absolute = join(taskFolder(ref), name)
    return {
        name,
        path: `${ref.toLowerCase()}/${name}`,
        absolutePath: absolute,
        size: statSync(absolute).size,
        isImage: isImageFile(name),
    }
}

/** Every file attached to a task, oldest first. */
export function listTaskAttachments(ref: string): TaskAttachment[] {
    const folder = taskFolder(ref)
    if (!existsSync(folder)) return []

    return readdirSync(folder, { withFileTypes: true })
        .filter((entry) => entry.isFile() && !entry.name.startsWith("."))
        .map((entry) => describe(ref, entry.name))
        .sort((a, b) => a.name.localeCompare(b.name))
}

export function addTaskAttachment(
    ref: string,
    filename: string,
    data: Uint8Array | ArrayBuffer,
): TaskAttachment {
    const folder = taskFolder(ref)
    mkdirSync(folder, { recursive: true })

    const name = uniqueName(folder, safeFilename(filename))
    writeFileSync(
        join(folder, name),
        new Uint8Array(
            data instanceof Uint8Array ? data : new Uint8Array(data),
        ),
    )

    return describe(ref, name)
}

export function removeTaskAttachment(ref: string, name: string): void {
    const folder = taskFolder(ref)
    const safe = safeFilename(name)
    const absolute = join(folder, safe)
    if (!existsSync(absolute) || !statSync(absolute).isFile()) {
        throw new Error(`No attachment '${name}' on '${ref}'.`)
    }
    rmSync(absolute)
}

export function deleteTaskAttachments(ref: string): void {
    const folder = taskFolder(ref)
    if (existsSync(folder)) rmSync(folder, { recursive: true, force: true })
}

/** Resolve a task ref + filename to an absolute path, refusing anything that
 *  escapes the task's own folder — the guard the server's asset route needs
 *  before it streams a file by name off disk. */
export function resolveTaskAsset(ref: string, name: string): string | null {
    const folder = taskFolder(ref)
    const prefix = folder.endsWith(sep) ? folder : folder + sep
    const absolute = resolve(folder, safeFilename(name))
    if (!absolute.startsWith(prefix)) return null
    return existsSync(absolute) && statSync(absolute).isFile() ? absolute : null
}
