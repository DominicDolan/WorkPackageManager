import {
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs"
import {
    basename,
    dirname,
    extname,
    join,
    relative,
    resolve,
    sep,
} from "node:path"
import { workspace } from "../config/paths"
import type {
    Note,
    NoteAttachment,
    NoteSummary,
    NotesGitInfo,
    NotesWorkspaceInfo,
} from "../shared/types"

/**
 * Notes, backed by the file system rather than the database.
 *
 * Everything else this tool tracks is workflow state and belongs in SQLite.
 * Notes are prose, and prose wants to be a file: greppable, editable in any
 * editor, diffable, and above all versioned by Git rather than by a table nobody
 * can read without the app. So the folder *is* the store — this module only
 * knows how to read and write it, and the on-disk layout is the schema:
 *
 * ```text
 * <notesDir>/                  its own Git repository
 *   ideas/gantt-is-slow.md     a note: YAML-ish frontmatter, then Markdown
 *   attachments/
 *     ideas/gantt-is-slow/     one folder per note
 *       screenshot.png
 * ```
 *
 * A note's identity is its path. There is no id and nothing mirrored in the
 * database, because a note renamed or rewritten by another editor — or pulled in
 * from a clone on another machine — has to keep working, and anything cached
 * here would be a second source of truth waiting to disagree.
 */

/** Resolved lazily, never at import: `tasks help` and `tasks init` load this
 *  module from outside a workspace, where resolving one throws. */
const ws = () => workspace()

/** Where attachments live, relative to the notes root. */
const ATTACHMENTS = "attachments"

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

/* ------------------------------------------------------------------ paths */

export function notesDir(): string {
    return ws().notesDir
}

export function notesDirExists(): boolean {
    return existsSync(ws().notesDir) && statSync(ws().notesDir).isDirectory()
}

/** Create the folder, and make it a Git repository unless it already is one or
 *  is inside somebody else's. Idempotent — safe to call before every write. */
export function ensureNotesDir(): void {
    if (!existsSync(ws().notesDir))
        mkdirSync(ws().notesDir, { recursive: true })
}

function requireNotesDir(): string {
    if (!notesDirExists()) {
        throw new Error(
            `The notes folder ${ws().notesDir} does not exist. Create it with \`tasks notes init\`, ` +
                "or point 'notesDir' in tasks.config.json at an existing one.",
        )
    }
    return ws().notesDir
}

/**
 * Turn user input into a safe notes-root-relative path.
 *
 * The web UI sends these straight off a text field and the CLI off the command
 * line, so this is the boundary that stops `../../.ssh/id_rsa` from being a note
 * — every path that reaches the file system goes through here or through
 * `resolveInNotes`, and nothing else builds one by concatenation.
 */
export function normalizeNotePath(
    input: string,
    { extension = true } = {},
): string {
    const cleaned = String(input).trim().replace(/\\/g, "/").replace(/^\/+/, "")
    if (!cleaned) throw new Error("A note path is required.")
    if (cleaned.includes("\0"))
        throw new Error("A note path may not contain null bytes.")

    const parts = cleaned.split("/").filter(Boolean)
    if (!parts.length) throw new Error("A note path is required.")
    for (const part of parts) {
        if (part === "." || part === "..")
            throw new Error(`Invalid note path '${input}'.`)
        if (part.startsWith("."))
            throw new Error("Note path segments may not start with a dot.")
    }
    if (parts[0] === ATTACHMENTS)
        throw new Error(`'${ATTACHMENTS}/' is reserved for attachments.`)

    const path = parts.join("/")
    if (!extension) return path
    return path.toLowerCase().endsWith(".md") ? path : `${path}.md`
}

/**
 * Resolve a notes-root-relative path to disk, refusing anything that escapes the
 * folder. The same guard `resolveArtifact` gives the aio-vr workspace, and for
 * the same reason: attachments are streamed straight off disk by path.
 */
export function resolveInNotes(relativePath: string): string | null {
    if (!relativePath || relativePath.includes("\0")) return null
    const root = ws().notesDir
    const absolute = resolve(root, relativePath.replace(/\\/g, "/"))
    const prefix = root.endsWith(sep) ? root : root + sep
    if (absolute !== root && !absolute.startsWith(prefix)) return null
    return absolute
}

/** As above, but only when the file is really there. */
export function resolveNoteAsset(relativePath: string): string | null {
    const absolute = resolveInNotes(relativePath)
    if (!absolute || !existsSync(absolute) || !statSync(absolute).isFile())
        return null
    return absolute
}

/** A filename-safe slug, used when a note is created from a title alone. */
export function slugify(title: string): string {
    return (
        title
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 80) || "note"
    )
}

/* ----------------------------------------------------------- frontmatter */

interface Frontmatter {
    title?: string
    tags?: string[]
    created?: string
    updated?: string
}

/**
 * Split `---` frontmatter off the top of a file.
 *
 * Deliberately not a YAML parser: the four keys written here are flat strings
 * and one list, and pulling in a YAML dependency to read them would be the
 * heaviest thing in the package. Anything it does not understand is left alone
 * rather than dropped — a note edited in Obsidian keeps whatever else it put up
 * there, because unknown lines are preserved on write.
 */
function splitFrontmatter(raw: string): {
    fields: Map<string, string>
    body: string
} {
    const fields = new Map<string, string>()
    const normalized = raw.replace(/^\uFEFF/, "")
    if (!normalized.startsWith("---"))
        return { fields, body: normalized.replace(/^\n+/, "") }

    const lines = normalized.split("\n")
    let end = -1
    for (let index = 1; index < lines.length; index += 1) {
        if (lines[index]!.trim() === "---") {
            end = index
            break
        }
    }
    if (end === -1) return { fields, body: normalized }

    for (const line of lines.slice(1, end)) {
        const separator = line.indexOf(":")
        if (separator === -1) continue
        const key = line.slice(0, separator).trim()
        if (key) fields.set(key, line.slice(separator + 1).trim())
    }

    return {
        fields,
        body: lines
            .slice(end + 1)
            .join("\n")
            .replace(/^\n+/, ""),
    }
}

function unquote(value: string): string {
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
        return value.slice(1, -1).replace(/\\(["\\])/g, "$1")
    }
    if (value.length >= 2 && value.startsWith("'") && value.endsWith("'"))
        return value.slice(1, -1)
    return value
}

function quote(value: string): string {
    return `"${value.replace(/([\\"])/g, "\\$1")}"`
}

function parseTags(value: string | undefined): string[] {
    if (!value) return []
    const inner =
        value.startsWith("[") && value.endsWith("]")
            ? value.slice(1, -1)
            : value
    return inner
        .split(",")
        .map((tag) => unquote(tag.trim()).replace(/^#/, "").trim())
        .filter(Boolean)
}

function readFrontmatter(fields: Map<string, string>): Frontmatter {
    return {
        title: fields.has("title") ? unquote(fields.get("title")!) : undefined,
        tags: fields.has("tags") ? parseTags(fields.get("tags")!) : undefined,
        created: fields.has("created")
            ? unquote(fields.get("created")!)
            : undefined,
        updated: fields.has("updated")
            ? unquote(fields.get("updated")!)
            : undefined,
    }
}

/** Rebuild the file: our four keys first, then any others the file already had. */
function serialize(
    meta: {
        title: string
        tags: string[]
        createdAt: string
        updatedAt: string
    },
    body: string,
    existing = new Map<string, string>(),
): string {
    const lines = [
        `title: ${quote(meta.title)}`,
        `tags: [${meta.tags.map((tag) => quote(tag)).join(", ")}]`,
        `created: ${meta.createdAt}`,
        `updated: ${meta.updatedAt}`,
    ]

    for (const [key, value] of existing) {
        if (!["title", "tags", "created", "updated"].includes(key))
            lines.push(`${key}: ${value}`)
    }

    const trimmed = body.replace(/^\n+/, "").replace(/\s+$/, "")
    return `---\n${lines.join("\n")}\n---\n\n${trimmed}\n`
}

/** The first prose line or two, with Markdown syntax knocked off the front. */
function excerptOf(body: string): string {
    const text = body
        .split("\n")
        .filter((line) => !/^\s*(#{1,6}\s|```|---\s*$|\|)/.test(line))
        .join(" ")
        .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
        .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/[*_`>]/g, "")
        .replace(/\s+/g, " ")
        .trim()
    return text.length > 180 ? `${text.slice(0, 177)}…` : text
}

/* -------------------------------------------------------------- reading */

function isoOf(value: Date): string {
    return value.toISOString()
}

function summarize(
    path: string,
    raw: string,
    absolute: string,
): { summary: NoteSummary; body: string; fields: Map<string, string> } {
    const { fields, body } = splitFrontmatter(raw)
    const meta = readFrontmatter(fields)
    const stats = statSync(absolute)

    return {
        fields,
        body,
        summary: {
            path,
            title:
                meta.title?.trim() ||
                basename(path, ".md").replace(/[-_]+/g, " "),
            tags: meta.tags ?? [],
            folder: dirname(path) === "." ? "" : dirname(path),
            excerpt: excerptOf(body),
            createdAt: meta.created || isoOf(stats.birthtime ?? stats.mtime),
            updatedAt: meta.updated || isoOf(stats.mtime),
        },
    }
}

/** Every `.md` file under the notes root, newest first. Dot-directories, the
 *  attachments tree and `.git` are skipped — the last of those matters, since a
 *  Git repo is full of files this would otherwise happily walk. */
export function listNotes(
    options: { tag?: string; folder?: string; search?: string } = {},
): NoteSummary[] {
    if (!notesDirExists()) return []
    const root = ws().notesDir
    const found: NoteSummary[] = []

    const walk = (directory: string): void => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            if (entry.name.startsWith(".")) continue
            const absolute = join(directory, entry.name)
            const path = relative(root, absolute).split(sep).join("/")

            if (entry.isDirectory()) {
                if (path === ATTACHMENTS) continue
                walk(absolute)
                continue
            }
            if (!entry.isFile() || extname(entry.name).toLowerCase() !== ".md")
                continue

            try {
                found.push(
                    summarize(path, readFileSync(absolute, "utf8"), absolute)
                        .summary,
                )
            } catch {
                // An unreadable file should cost one row, not the whole list.
            }
        }
    }

    walk(root)

    const search = options.search?.trim().toLowerCase()
    return found
        .filter((note) =>
            options.tag ? note.tags.includes(options.tag) : true,
        )
        .filter((note) =>
            options.folder ? note.folder === options.folder : true,
        )
        .filter((note) =>
            search
                ? note.title.toLowerCase().includes(search) ||
                  note.path.toLowerCase().includes(search) ||
                  note.excerpt.toLowerCase().includes(search)
                : true,
        )
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

/** Every folder that holds at least one note, for the sidebar's filter. */
export function listFolders(): string[] {
    return [
        ...new Set(
            listNotes()
                .map((note) => note.folder)
                .filter(Boolean),
        ),
    ].sort()
}

/** Every tag in use, most-used first. */
export function listTags(): string[] {
    const counts = new Map<string, number>()
    for (const note of listNotes()) {
        for (const tag of note.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1)
    }
    return [...counts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([tag]) => tag)
}

/**
 * Give every folder of loose images a note of its own.
 *
 * A folder holding nothing but images — a screenshot tool's output directory, a
 * board exported out of Miro, a pile of references dragged in from a browser —
 * is invisible to a view that lists `.md` files and nothing else. That is how
 * they get lost: the files are right there in the repository and the app has no
 * row to put them in.
 *
 * Rather than grow a second kind of list item for them, each such folder gets
 * the thing the app already knows how to show: a note, titled after the folder
 * and linking every image in it. From then on it is an ordinary note — editable,
 * taggable, renameable — and this never looks at that folder again.
 *
 * Two rules keep it from ever touching somebody's writing. It only creates, and
 * only in a folder with no note at all, so a note that exists is never edited,
 * re-linked or reordered — a folder that already has one shows its loose images
 * through `readAttachments` instead. And it skips the root, which is every
 * note's folder rather than a subject of its own; an index note there would be a
 * second table of contents for the whole collection.
 *
 * Idempotent by construction: the note it writes is the `.md` that makes the
 * folder ineligible next time.
 */
export function indexImageFolders(): string[] {
    if (!notesDirExists()) return []
    const root = ws().notesDir
    const created: string[] = []

    const walk = (directory: string): void => {
        const entries = readdirSync(directory, { withFileTypes: true })
        const path = relative(root, directory).split(sep).join("/")

        for (const entry of entries) {
            if (!entry.isDirectory() || entry.name.startsWith(".")) continue
            const child = path ? `${path}/${entry.name}` : entry.name
            if (child === ATTACHMENTS) continue
            walk(join(directory, entry.name))
        }

        if (!path) return
        if (
            entries.some(
                (entry) =>
                    entry.isFile() &&
                    extname(entry.name).toLowerCase() === ".md",
            )
        )
            return

        const images = entries
            .filter(
                (entry) =>
                    entry.isFile() &&
                    !entry.name.startsWith(".") &&
                    isImageFile(entry.name),
            )
            .map((entry) => entry.name)
            .sort((a, b) => a.localeCompare(b))
        if (!images.length) return

        const title = basename(directory)
        // Linked relatively, and with the folder's own filenames, so the note reads
        // the same in Obsidian or on GitHub as it does here.
        const body = images
            .map((name) => `![${name}](${encodeURI(`./${name}`)})`)
            .join("\n\n")

        try {
            created.push(
                createNote({
                    title,
                    path: `${path}/${slugify(title)}.md`,
                    body,
                }).path,
            )
        } catch {
            // A folder whose name yields an unusable path should cost that folder, not
            // every other one behind it in the walk.
        }
    }

    walk(root)
    return created
}

/** Where a note's attachments live, relative to the notes root. */
function attachmentsFolder(notePath: string): string {
    return `${ATTACHMENTS}/${notePath.replace(/\.md$/i, "")}`
}

/** The path as it should be written in the Markdown: relative to the note, so
 *  the file keeps working in Obsidian, on GitHub, or in any other reader. */
function hrefFor(notePath: string, assetPath: string): string {
    const from = dirname(notePath)
    const href = relative(from === "." ? "" : from, assetPath)
        .split(sep)
        .join("/")
    return href.startsWith(".") ? href : `./${href}`
}

function isImageFile(name: string): boolean {
    return IMAGE_EXTENSIONS.has(extname(name).toLowerCase())
}

/** The files of one folder, described as attachments of the given note. */
function attachmentsIn(
    folder: string,
    notePath: string,
    accept: (name: string) => boolean,
    uploaded: boolean,
): NoteAttachment[] {
    // `resolveInNotes` refuses the empty string, so the root travels as '.'.
    const absolute = resolveInNotes(folder || ".")
    if (!absolute || !existsSync(absolute)) return []

    return readdirSync(absolute, { withFileTypes: true })
        .filter(
            (entry) =>
                entry.isFile() &&
                !entry.name.startsWith(".") &&
                accept(entry.name),
        )
        .map((entry) => {
            const path = folder ? `${folder}/${entry.name}` : entry.name
            return {
                name: entry.name,
                path,
                href: hrefFor(notePath, path),
                size: statSync(join(absolute, entry.name)).size,
                isImage: isImageFile(entry.name),
                uploaded,
            }
        })
}

/**
 * What a note has hanging off it: its uploads, and the images sitting beside it.
 *
 * The second half matters because most images in a notes folder were never
 * uploaded through this app. They were dropped in by a screenshot tool, synced
 * from Obsidian, or copied out of a board export, and they sit next to the note
 * they belong to rather than under `attachments/`. Reading only the upload
 * folder made every one of those invisible.
 *
 * Only *images* are picked up from the note's own folder. A folder of notes is
 * also full of files that are not attachments of anything — fetched issue JSON,
 * exports, stray archives — and listing those under whichever note happens to
 * share a directory with them would be noise, not evidence.
 */
function readAttachments(notePath: string): NoteAttachment[] {
    const folder = dirname(notePath) === "." ? "" : dirname(notePath)
    return [
        ...attachmentsIn(
            attachmentsFolder(notePath),
            notePath,
            () => true,
            true,
        ),
        ...attachmentsIn(folder, notePath, isImageFile, false),
    ].sort((a, b) => a.name.localeCompare(b.name))
}

/** An image in the notes folder, located rather than described. */
export interface NoteImage {
    name: string
    /** Path relative to the notes root. */
    path: string
    /** Absolute path on disk. The only field a reader outside this app needs. */
    absolute: string
    size: number
    /** The note it hangs off, where that is unambiguous. */
    note: string | null
}

/**
 * Every image in the notes folder, or in one note or folder of it.
 *
 * This exists for readers that are not a browser — chiefly an agent, which
 * cannot see a picture printed to a terminal but can open a file if something
 * tells it where the file is. So the useful output is not a rendering, it is a
 * path: absolute, resolved, and ready to hand to whatever does the looking.
 *
 * `target` may be a note (its own images, exactly as its detail view shows
 * them), a folder (everything under it), or nothing at all (the lot).
 */
export function listImages(target?: string): NoteImage[] {
    if (!notesDirExists()) return []
    const root = ws().notesDir

    const describe = (path: string, note: string | null): NoteImage => ({
        name: basename(path),
        path,
        absolute: resolveInNotes(path)!,
        size: statSync(resolveInNotes(path)!).size,
        note,
    })

    if (target?.toLowerCase().endsWith(".md")) {
        const note = readNote(target)
        return note.attachments
            .filter((attachment) => attachment.isImage)
            .map((attachment) => describe(attachment.path, note.path))
    }

    const scope = target ? normalizeNotePath(target, { extension: false }) : ""
    const found: NoteImage[] = []

    const walk = (directory: string): void => {
        const entries = readdirSync(directory, { withFileTypes: true })

        // Where a folder holds exactly one note, its loose images are that note's.
        // Two or more and there is no honest answer, so the image gets none rather
        // than being filed under whichever one sorted first.
        const notes = entries.filter(
            (entry) =>
                entry.isFile() && extname(entry.name).toLowerCase() === ".md",
        )
        const sole = notes.length === 1 ? notes[0]!.name : null

        for (const entry of entries) {
            if (entry.name.startsWith(".")) continue
            const absolute = join(directory, entry.name)
            const path = relative(root, absolute).split(sep).join("/")

            if (entry.isDirectory()) {
                walk(absolute)
                continue
            }
            if (!entry.isFile() || !isImageFile(entry.name)) continue

            // Anything under `attachments/` belongs to the note that folder is named
            // for, whichever directory it happens to sit in.
            const uploaded = /^attachments\/(.+)\/[^/]+$/.exec(path)
            const owner = uploaded
                ? `${uploaded[1]}.md`
                : sole
                  ? relative(root, join(directory, sole)).split(sep).join("/")
                  : null
            found.push(describe(path, owner))
        }
    }

    walk(root)
    return found
        .filter((image) =>
            scope
                ? image.path === scope || image.path.startsWith(`${scope}/`)
                : true,
        )
        .sort((a, b) => a.path.localeCompare(b.path))
}

export function noteExists(path: string): boolean {
    const absolute = resolveInNotes(normalizeNotePath(path))
    return !!absolute && existsSync(absolute) && statSync(absolute).isFile()
}

export function readNote(path: string): Note {
    requireNotesDir()
    const notePath = normalizeNotePath(path)
    const absolute = resolveInNotes(notePath)
    if (!absolute || !existsSync(absolute))
        throw new Error(`No note at '${notePath}'.`)

    const { summary, body } = summarize(
        notePath,
        readFileSync(absolute, "utf8"),
        absolute,
    )
    return { ...summary, body, attachments: readAttachments(notePath) }
}

/* -------------------------------------------------------------- writing */

/** Add `-2`, `-3`… until the name is free. Used for both notes and uploads, so
 *  neither a same-titled note nor a second `screenshot.png` overwrites anything. */
function uniquePath(candidate: string): string {
    const absolute = resolveInNotes(candidate)!
    if (!existsSync(absolute)) return candidate

    const extension = extname(candidate)
    const stem = candidate.slice(0, candidate.length - extension.length)
    for (let index = 2; index < 1000; index += 1) {
        const next = `${stem}-${index}${extension}`
        if (!existsSync(resolveInNotes(next)!)) return next
    }
    throw new Error(`Could not find a free filename near '${candidate}'.`)
}

export interface CreateNoteInput {
    title: string
    /** Folder to file it under. Optional; the root by default. */
    folder?: string
    /** Explicit path, overriding the slug generated from the title. */
    path?: string
    body?: string
    tags?: string[]
}

export function createNote(input: CreateNoteInput): Note {
    ensureNotesDir()
    const title = input.title.trim()
    if (!title) throw new Error("A note needs a title.")

    const folder = input.folder
        ? normalizeNotePath(input.folder, { extension: false })
        : ""
    const requested = input.path
        ? normalizeNotePath(input.path)
        : normalizeNotePath(
              folder ? `${folder}/${slugify(title)}` : slugify(title),
          )

    const path = uniquePath(requested)
    const absolute = resolveInNotes(path)!
    mkdirSync(dirname(absolute), { recursive: true })

    const now = new Date().toISOString()
    writeFileSync(
        absolute,
        serialize(
            { title, tags: input.tags ?? [], createdAt: now, updatedAt: now },
            input.body ?? "",
        ),
    )

    autoCommit(`notes: add ${path}`)
    return readNote(path)
}

export interface UpdateNoteInput {
    title?: string
    body?: string
    tags?: string[]
    /** Move or rename the note. Its attachments folder moves with it. */
    path?: string
}

export function updateNote(path: string, input: UpdateNoteInput): Note {
    const notePath = normalizeNotePath(path)
    const absolute = resolveInNotes(notePath)
    if (!absolute || !existsSync(absolute))
        throw new Error(`No note at '${notePath}'.`)

    const raw = readFileSync(absolute, "utf8")
    const { fields, body } = splitFrontmatter(raw)
    const current = summarize(notePath, raw, absolute).summary

    const title = input.title?.trim() || current.title
    const nextBody = input.body ?? body
    const tags = input.tags ?? current.tags
    const now = new Date().toISOString()

    // Rename first: writing the new contents to the old path and moving it after
    // would leave the note at neither path if the move failed.
    let finalPath = notePath
    if (input.path !== undefined) {
        const requested = normalizeNotePath(input.path)
        if (requested !== notePath) {
            const target = resolveInNotes(requested)!
            if (existsSync(target))
                throw new Error(`A note already exists at '${requested}'.`)
            mkdirSync(dirname(target), { recursive: true })
            renameSync(absolute, target)
            moveAttachments(notePath, requested)
            finalPath = requested
        }
    }

    writeFileSync(
        resolveInNotes(finalPath)!,
        serialize(
            { title, tags, createdAt: current.createdAt, updatedAt: now },
            nextBody,
            fields,
        ),
    )

    autoCommit(
        finalPath === notePath
            ? `notes: update ${finalPath}`
            : `notes: rename ${notePath} → ${finalPath}`,
    )
    return readNote(finalPath)
}

/** Append to a note without reading it first — how the CLI's `--append` and an
 *  agent jotting something down both write. */
export function appendToNote(path: string, text: string): Note {
    const note = readNote(path)
    const separator = note.body.trim() ? "\n\n" : ""
    return updateNote(note.path, {
        body: `${note.body.replace(/\s+$/, "")}${separator}${text.trim()}`,
    })
}

function moveAttachments(fromNote: string, toNote: string): void {
    const from = resolveInNotes(attachmentsFolder(fromNote))
    if (!from || !existsSync(from)) return
    const to = resolveInNotes(attachmentsFolder(toNote))!
    mkdirSync(dirname(to), { recursive: true })
    renameSync(from, to)
}

export function deleteNote(
    path: string,
    { keepAttachments = false } = {},
): string {
    const notePath = normalizeNotePath(path)
    const absolute = resolveInNotes(notePath)
    if (!absolute || !existsSync(absolute))
        throw new Error(`No note at '${notePath}'.`)

    rmSync(absolute)
    if (!keepAttachments) {
        const attachments = resolveInNotes(attachmentsFolder(notePath))
        if (attachments && existsSync(attachments))
            rmSync(attachments, { recursive: true, force: true })
    }

    autoCommit(`notes: delete ${notePath}`)
    return notePath
}

/* ---------------------------------------------------------- attachments */

/** Strip a client-supplied filename down to a basename that is safe to write. */
function safeFilename(name: string): string {
    const base = basename(String(name).replace(/\\/g, "/")).trim()
    const cleaned = base
        .replace(/[^A-Za-z0-9._ -]+/g, "-")
        .replace(/^[.\-]+/, "")
        .slice(0, 120)
    return cleaned || `file-${Date.now()}`
}

/**
 * Store a file beside a note and hand back the Markdown that links to it.
 *
 * The caller — a paste into the editor, a drag-and-drop, `tasks notes attach` —
 * gets the snippet rather than being trusted to build the path itself, so there
 * is exactly one place that decides where attachments live.
 */
export function addAttachment(
    notePath: string,
    filename: string,
    data: Uint8Array | ArrayBuffer,
): { attachment: NoteAttachment; markdown: string } {
    const note = normalizeNotePath(notePath)
    if (!noteExists(note)) throw new Error(`No note at '${note}'.`)

    const folder = attachmentsFolder(note)
    mkdirSync(resolveInNotes(folder)!, { recursive: true })

    const path = uniquePath(`${folder}/${safeFilename(filename)}`)
    const absolute = resolveInNotes(path)!
    writeFileSync(
        absolute,
        new Uint8Array(
            data instanceof Uint8Array ? data : new Uint8Array(data),
        ),
    )

    const attachment: NoteAttachment = {
        name: basename(path),
        path,
        href: hrefFor(note, path),
        size: statSync(absolute).size,
        isImage: isImageFile(path),
        uploaded: true,
    }

    autoCommit(`notes: attach ${attachment.name} to ${note}`)
    return {
        attachment,
        markdown: `${attachment.isImage ? "!" : ""}[${attachment.name}](${encodeURI(attachment.href)})`,
    }
}

export function removeAttachment(notePath: string, name: string): void {
    const note = normalizeNotePath(notePath)
    const path = `${attachmentsFolder(note)}/${safeFilename(name)}`
    const absolute = resolveNoteAsset(path)
    if (!absolute) throw new Error(`No attachment '${name}' on '${note}'.`)
    rmSync(absolute)
    autoCommit(`notes: remove ${name} from ${note}`)
}

/**
 * Resolve a link written inside a note (`./attachments/x.png`, `../shared.png`)
 * to a notes-root-relative path, so the preview can ask the server for it.
 * Absolute URLs and anything escaping the notes folder come back null.
 */
export function resolveNoteLink(notePath: string, href: string): string | null {
    if (
        /^[a-z][a-z0-9+.-]*:/i.test(href) ||
        href.startsWith("//") ||
        href.startsWith("#")
    )
        return null
    const note = normalizeNotePath(notePath)
    const folder = dirname(note) === "." ? "" : dirname(note)
    const decoded = decodeURI(href.split("#")[0]!.split("?")[0]!)
    const joined = href.startsWith("/")
        ? decoded.slice(1)
        : `${folder ? `${folder}/` : ""}${decoded}`
    const absolute = resolveInNotes(joined)
    if (!absolute) return null
    return relative(ws().notesDir, absolute).split(sep).join("/")
}

/* ---------------------------------------------------------------- git */

function git(
    args: string[],
    cwd = ws().notesDir,
    timeoutMs?: number,
): { code: number; stdout: string; stderr: string; timedOut: boolean } {
    const result = Bun.spawnSync(["git", ...args], {
        cwd,
        // Never inherit stdio: a credential prompt on a push would hang the request.
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        ...(timeoutMs ? { timeout: timeoutMs } : {}),
    })
    return {
        code: result.exitCode ?? 1,
        stdout: result.stdout.toString(),
        stderr: result.stderr.toString(),
        // Bun reports a timeout kill as a signal rather than an exit code.
        timedOut:
            result.signalCode === "SIGTERM" || result.signalCode === "SIGKILL",
    }
}

/** Whether the notes folder is the root of a Git repository. A folder that
 *  merely sits *inside* one does not count — committing it would write to the
 *  enclosing repo, which is never what a notes folder means. */
export function isNotesRepo(): boolean {
    if (!notesDirExists()) return false
    const top = git(["rev-parse", "--show-toplevel"])
    return (
        top.code === 0 && resolve(top.stdout.trim()) === resolve(ws().notesDir)
    )
}

export function notesGitInfo(): NotesGitInfo {
    if (!isNotesRepo()) {
        return {
            repo: false,
            branch: null,
            dirty: 0,
            lastCommit: null,
            upstream: null,
            unpushed: null,
        }
    }

    const branch = git(["branch", "--show-current"]).stdout.trim() || null
    const status = git(["status", "--porcelain"])
    const dirty = status.stdout.split("\n").filter((line) => line.trim()).length

    const log = git(["log", "-1", "--format=%h%x1f%s%x1f%aI"])
    const [shortSha, subject, date] = log.stdout.trim().split("\x1f")
    const lastCommit =
        log.code === 0 && shortSha
            ? { shortSha, subject: subject ?? "", date: date ?? "" }
            : null

    const upstreamResult = git([
        "rev-parse",
        "--abbrev-ref",
        "--symbolic-full-name",
        "@{upstream}",
    ])
    const upstream =
        upstreamResult.code === 0 ? upstreamResult.stdout.trim() || null : null

    let unpushed: number | null = null
    if (upstream) {
        const counted = git(["rev-list", "--count", `${upstream}..HEAD`])
        if (counted.code === 0) unpushed = Number(counted.stdout.trim()) || 0
    }

    return { repo: true, branch, dirty, lastCommit, upstream, unpushed }
}

export function notesWorkspaceInfo(): NotesWorkspaceInfo {
    return {
        dir: ws().notesDir,
        exists: notesDirExists(),
        autoCommit: ws().config.notesAutoCommit,
        git: notesGitInfo(),
    }
}

/**
 * Commit whatever is outstanding in the notes folder.
 *
 * Returns null when there was nothing to commit, which is the common case and
 * not an error: two saves in a row with no change between them, or a folder that
 * is not a repository at all.
 */
export function commitNotes(message: string): string | null {
    if (!isNotesRepo()) return null
    if (!git(["status", "--porcelain"]).stdout.trim()) return null

    const staged = git(["add", "-A"])
    if (staged.code !== 0)
        throw new Error(
            staged.stderr.trim() || "Could not stage the notes changes.",
        )

    const committed = git(["commit", "-m", message])
    if (committed.code !== 0) {
        throw new Error(
            committed.stderr.trim() ||
                committed.stdout.trim() ||
                "Could not commit the notes changes.",
        )
    }
    return git(["rev-parse", "--short", "HEAD"]).stdout.trim() || null
}

/**
 * The commit fired after every write, when `notesAutoCommit` is on.
 *
 * A failure here must not lose the edit: the file is already written and that is
 * the part that matters, so this reports and moves on rather than throwing back
 * into a save the user believes succeeded. `tasks notes sync` picks up whatever
 * this could not commit.
 */
function autoCommit(message: string): void {
    if (!ws().config.notesAutoCommit) return
    try {
        commitNotes(message)
    } catch (error) {
        console.error(
            `notes: auto-commit failed — ${error instanceof Error ? error.message : String(error)}`,
        )
    }
}

/** Commit anything outstanding, then optionally push. */
export function syncNotes({
    push = false,
    message,
}: { push?: boolean; message?: string } = {}): {
    committed: string | null
    pushed: boolean
    git: NotesGitInfo
} {
    if (!isNotesRepo())
        throw new Error(
            `${ws().notesDir} is not a Git repository. Run \`tasks notes init\`.`,
        )

    const committed = commitNotes(
        message ??
            `notes: sync ${new Date().toISOString().slice(0, 16).replace("T", " ")}`,
    )

    let pushed = false
    if (push) {
        const info = notesGitInfo()
        const result = info.upstream
            ? git(["push"])
            : git(["push", "--set-upstream", "origin", info.branch ?? "main"])
        if (result.code !== 0)
            throw new Error(
                result.stderr.trim() || "Could not push the notes repository.",
            )
        pushed = true
    }

    return { committed, pushed, git: notesGitInfo() }
}

/** A pull reaches the network, and an unreachable remote must fail rather than
 *  hold the request open. */
const FETCH_TIMEOUT_MS = 120_000

export interface NotesPull {
    /** Commits the fast-forward brought in. Zero when already up to date. */
    received: number
    /** The remote-tracking ref that was merged, e.g. `origin/main`. */
    upstream: string | null
    /** Local commits the remote does not have — a reminder to push, not a failure. */
    unpushed: number
    git: NotesGitInfo
}

/**
 * Fetch the notes repository and fast-forward onto whatever came back.
 *
 * Both the Notes view and Issues read out of this one folder — the issue JSON
 * files live there too — so this is the single "go and get what everyone else
 * wrote" action behind both.
 *
 * Fast-forward only, deliberately. A merge that stops half-done would leave the
 * notes folder in a conflicted state that this UI has no way to resolve, so a
 * genuinely diverged repository is reported and left exactly as it was for the
 * user to reconcile in a terminal. Local changes are not committed first: the
 * Commit button next to this one does that, and quietly committing someone's
 * half-written note because they asked to pull would be a surprise.
 */
export function pullNotes(): NotesPull {
    if (!isNotesRepo())
        throw new Error(
            `${ws().notesDir} is not a Git repository. Run \`tasks notes init\`.`,
        )

    const before = notesGitInfo()
    if (!before.branch)
        throw new Error(
            "The notes repository is on a detached HEAD — check out a branch first.",
        )

    const remotes = git(["remote"])
        .stdout.split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
    if (!remotes.length)
        throw new Error("The notes repository has no remote to pull from.")
    // The branch's own remote when it has one, otherwise the conventional name,
    // otherwise whatever single remote this repository does have.
    const remote =
        before.upstream?.split("/")[0] ??
        (remotes.includes("origin") ? "origin" : remotes[0]!)

    const fetched = git(["fetch", remote], undefined, FETCH_TIMEOUT_MS)
    if (fetched.timedOut)
        throw new Error(`Fetching from '${remote}' timed out.`)
    if (fetched.code !== 0) {
        throw new Error(
            fetched.stderr.trim() || `Could not fetch from '${remote}'.`,
        )
    }

    const tracking = before.upstream ?? `${remote}/${before.branch}`
    const remoteSha = git([
        "rev-parse",
        "--verify",
        "--quiet",
        `${tracking}^{commit}`,
    ]).stdout.trim()
    if (!remoteSha) {
        // Fetched fine, but this branch does not exist on the remote yet — a local
        // branch nobody has pushed. Nothing to merge, and nothing wrong.
        return { received: 0, upstream: null, unpushed: 0, git: notesGitInfo() }
    }

    const localSha = git(["rev-parse", "HEAD"]).stdout.trim()
    const countBetween = (range: string): number =>
        Number(git(["rev-list", "--count", range]).stdout.trim()) || 0

    if (localSha === remoteSha) {
        return {
            received: 0,
            upstream: tracking,
            unpushed: 0,
            git: notesGitInfo(),
        }
    }

    const behind =
        git(["merge-base", "--is-ancestor", localSha, remoteSha]).code === 0
    if (!behind) {
        const ahead =
            git(["merge-base", "--is-ancestor", remoteSha, localSha]).code === 0
        if (ahead) {
            return {
                received: 0,
                upstream: tracking,
                unpushed: countBetween(`${tracking}..HEAD`),
                git: notesGitInfo(),
            }
        }
        throw new Error(
            `The notes repository has diverged from ${tracking} — each has commits the other does not. ` +
                "Reconcile it by hand (merge or rebase in a terminal); nothing was changed.",
        )
    }

    const received = countBetween(`HEAD..${tracking}`)
    const merged = git(["merge", "--ff-only", tracking])
    if (merged.code !== 0) {
        throw new Error(
            merged.stderr.trim() ||
                merged.stdout.trim() ||
                `Could not fast-forward onto ${tracking}.`,
        )
    }

    return { received, upstream: tracking, unpushed: 0, git: notesGitInfo() }
}

/**
 * Create the notes folder and make it a repository of its own.
 *
 * When the folder lands inside the repo being tracked (which the default
 * `../.notes` does), it is also added to that clone's `.git/info/exclude` — the
 * same treatment `tasks init` gives `.tasks/`, and for the same reason: a nested
 * repository showing up as an untracked path in the host repo's status is noise
 * at best and an accidental commit at worst.
 */
export function initNotes(): {
    dir: string
    created: boolean
    repoCreated: boolean
    excluded: "added" | "present" | "not-nested"
} {
    const created = !notesDirExists()
    ensureNotesDir()

    const repoCreated = !isNotesRepo()
    if (repoCreated) {
        const result = git(["init"])
        if (result.code !== 0)
            throw new Error(
                result.stderr.trim() ||
                    "Could not `git init` the notes folder.",
            )
        const readme = join(ws().notesDir, "README.md")
        if (!existsSync(readme)) {
            writeFileSync(
                readme,
                "# Notes\n\nMarkdown notes, one file per note, with attachments under `attachments/`.\n" +
                    "Written and read through `tasks notes` and the Notes view of `tasks web`.\n",
            )
        }
        commitNotes("notes: initialise notes repository")
    }

    return {
        dir: ws().notesDir,
        created,
        repoCreated,
        excluded: excludeFromHostRepo(),
    }
}

function excludeFromHostRepo(): "added" | "present" | "not-nested" {
    const prefix = ws().repoRoot.endsWith(sep)
        ? ws().repoRoot
        : ws().repoRoot + sep
    if (!ws().notesDir.startsWith(prefix)) return "not-nested"

    const gitDir = git(["rev-parse", "--absolute-git-dir"], ws().repoRoot)
    if (gitDir.code !== 0) return "not-nested"

    const entry = `${relative(ws().repoRoot, ws().notesDir).split(sep).join("/")}/`
    const infoDir = join(gitDir.stdout.trim(), "info")
    const excludePath = join(infoDir, "exclude")
    const existing = existsSync(excludePath)
        ? readFileSync(excludePath, "utf8")
        : ""
    if (existing.split("\n").some((line) => line.trim() === entry))
        return "present"

    mkdirSync(infoDir, { recursive: true })
    const separator = existing && !existing.endsWith("\n") ? "\n" : ""
    writeFileSync(
        excludePath,
        `${existing}${separator}\n# Notes workspace (work-task-manager) — its own Git repository\n${entry}\n`,
    )
    return "added"
}
