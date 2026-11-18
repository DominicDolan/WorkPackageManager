import { readFileSync, readdirSync } from "node:fs"
import { extname, join, relative, sep } from "node:path"
import type {
    TranscriptDetail,
    TranscriptLink,
    TranscriptSummary,
} from "@work-task-manager/shared"
import { getDb, nowIso } from "./db"
import {
    notesDir,
    notesDirExists,
    normalizeNotePath,
    resolveNoteAsset,
} from "./notes"
import { findInvestigation, findTask } from "./repo"

type LinkRow = {
    path: string
    target_kind: TranscriptLink["kind"]
    target_ref: string
}

function safePath(input: string): string {
    const path = normalizeNotePath(input, { extension: false })
    if (extname(path).toLowerCase() !== ".json")
        throw new Error("A transcript path must end in .json.")
    return path
}

function parseTranscript(path: string): TranscriptDetail | null {
    const absolute = resolveNoteAsset(path)
    if (!absolute) return null
    try {
        const raw = JSON.parse(readFileSync(absolute, "utf8")) as Record<
            string,
            unknown
        >
        const transcript = raw.transcript as Record<string, unknown> | null
        if (
            !transcript ||
            typeof transcript !== "object" ||
            typeof transcript.title !== "string" ||
            typeof transcript.content !== "string"
        )
            return null
        const content = transcript.content
        return {
            path,
            title: transcript.title,
            date: typeof transcript.date === "string" ? transcript.date : "",
            source: typeof raw.source === "string" ? raw.source : "unknown",
            fetchedAt: typeof raw.fetchedAt === "string" ? raw.fetchedAt : "",
            excerpt: content.replace(/\s+/g, " ").trim().slice(0, 240),
            content,
            links: [],
        }
    } catch {
        return null
    }
}

function linksFor(path: string): TranscriptLink[] {
    const rows = getDb()
        .query<LinkRow, [string]>(
            "SELECT path, target_kind, target_ref FROM transcript_links WHERE path = ? ORDER BY target_kind, target_ref",
        )
        .all(path)
    return rows.map((row) => ({ kind: row.target_kind, ref: row.target_ref }))
}

export function readTranscript(input: string): TranscriptDetail {
    const path = safePath(input)
    const transcript = parseTranscript(path)
    if (!transcript)
        throw new Error(`No transcript '${path}' in the notes folder.`)
    transcript.links = linksFor(path)
    return transcript
}

export function listTranscripts(): TranscriptSummary[] {
    if (!notesDirExists()) return []
    const root = notesDir()
    const found: TranscriptSummary[] = []
    const walk = (directory: string): void => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            if (entry.name.startsWith(".")) continue
            const absolute = join(directory, entry.name)
            const path = relative(root, absolute).split(sep).join("/")
            if (entry.isDirectory()) {
                if (path !== "attachments") walk(absolute)
            } else if (
                entry.isFile() &&
                extname(entry.name).toLowerCase() === ".json"
            ) {
                const transcript = parseTranscript(path)
                if (transcript) {
                    const { content: _content, ...summary } = transcript
                    found.push(summary)
                }
            }
        }
    }
    walk(root)
    const rows = getDb()
        .query<LinkRow, []>(
            "SELECT path, target_kind, target_ref FROM transcript_links ORDER BY target_kind, target_ref",
        )
        .all()
    const byPath = new Map<string, TranscriptLink[]>()
    for (const row of rows) {
        const links = byPath.get(row.path) ?? []
        links.push({ kind: row.target_kind, ref: row.target_ref })
        byPath.set(row.path, links)
    }
    for (const transcript of found)
        transcript.links = byPath.get(transcript.path) ?? []
    return found.sort(
        (a, b) =>
            b.date.localeCompare(a.date) || a.title.localeCompare(b.title),
    )
}

export function addTranscriptLink(
    path: string,
    kind: TranscriptLink["kind"],
    ref: string,
): TranscriptDetail {
    const transcript = readTranscript(path)
    if (kind !== "task" && kind !== "investigation")
        throw new Error(
            "A transcript can be attached to a task or investigation.",
        )
    if (!(kind === "task" ? findTask(ref) : findInvestigation(ref)))
        throw new Error(`No ${kind} '${ref}'.`)
    getDb()
        .query(
            "INSERT OR IGNORE INTO transcript_links (path, target_kind, target_ref, created_at) VALUES (?, ?, ?, ?)",
        )
        .run(transcript.path, kind, ref, nowIso())
    return readTranscript(transcript.path)
}

export function removeTranscriptLink(
    path: string,
    kind: TranscriptLink["kind"],
    ref: string,
): TranscriptDetail {
    const transcript = readTranscript(path)
    if (kind !== "task" && kind !== "investigation")
        throw new Error(
            "A transcript can be attached to a task or investigation.",
        )
    getDb()
        .query(
            "DELETE FROM transcript_links WHERE path = ? AND target_kind = ? AND target_ref = ?",
        )
        .run(transcript.path, kind, ref)
    return readTranscript(transcript.path)
}
