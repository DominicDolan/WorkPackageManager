import { getDb, nowIso } from "./db"
import { listNotes } from "./notes"
import type { NoteSummary } from "../shared/types"

export type NoteLinkSubject = "task" | "work-package"

/** Resolve links through the notes folder on every read. This deliberately
 * omits stale paths left by a file renamed outside the app rather than showing
 * a reference that cannot be opened. */
export function linkedNotes(
    subjectKind: NoteLinkSubject,
    subjectRef: string,
): NoteSummary[] {
    const paths = getDb()
        .query<{ note_path: string }, { $kind: string; $ref: string }>(
            `SELECT note_path FROM note_links
        WHERE subject_kind = $kind AND subject_ref = $ref COLLATE NOCASE
        ORDER BY attached_at DESC, note_path ASC`,
        )
        .all({ $kind: subjectKind, $ref: subjectRef })
        .map((row) => row.note_path)
    if (!paths.length) return []

    const notes = new Map(listNotes().map((note) => [note.path, note]))
    return paths.flatMap((path) => {
        const note = notes.get(path)
        return note ? [note] : []
    })
}

/** The raw links, newest first, for a caller that reads each note itself. */
export function noteLinkRows(
    subjectKind: NoteLinkSubject,
    subjectRef: string,
): { path: string; attachedAt: string }[] {
    return getDb()
        .query<
            { note_path: string; attached_at: string },
            { $kind: string; $ref: string }
        >(
            `SELECT note_path, attached_at FROM note_links
        WHERE subject_kind = $kind AND subject_ref = $ref COLLATE NOCASE
        ORDER BY attached_at DESC, note_path ASC`,
        )
        .all({ $kind: subjectKind, $ref: subjectRef })
        .map((row) => ({ path: row.note_path, attachedAt: row.attached_at }))
}

export function attachNote(
    subjectKind: NoteLinkSubject,
    subjectRef: string,
    notePath: string,
): void {
    getDb()
        .query(
            `INSERT OR IGNORE INTO note_links
         (subject_kind, subject_ref, note_path, attached_at)
       VALUES ($kind, $ref, $path, $at)`,
        )
        .run({
            $kind: subjectKind,
            $ref: subjectRef,
            $path: notePath,
            $at: nowIso(),
        })
}

export function detachNote(
    subjectKind: NoteLinkSubject,
    subjectRef: string,
    notePath: string,
): void {
    getDb()
        .query(
            `DELETE FROM note_links
        WHERE subject_kind = $kind AND subject_ref = $ref COLLATE NOCASE
          AND note_path = $path`,
        )
        .run({ $kind: subjectKind, $ref: subjectRef, $path: notePath })
}

export function detachAllNotes(
    subjectKind: NoteLinkSubject,
    subjectRef: string,
): void {
    getDb()
        .query(
            `DELETE FROM note_links
        WHERE subject_kind = $kind AND subject_ref = $ref COLLATE NOCASE`,
        )
        .run({ $kind: subjectKind, $ref: subjectRef })
}

/** Keep links intact when a note is renamed through this application. */
export function renameNoteLinks(fromPath: string, toPath: string): void {
    if (fromPath === toPath) return
    getDb().transaction(() => {
        getDb()
            .query(
                `INSERT OR IGNORE INTO note_links
           (subject_kind, subject_ref, note_path, attached_at)
         SELECT subject_kind, subject_ref, $to, attached_at
           FROM note_links WHERE note_path = $from`,
            )
            .run({ $from: fromPath, $to: toPath })
        getDb()
            .query("DELETE FROM note_links WHERE note_path = $from")
            .run({ $from: fromPath })
    })()
}

/** A deleted note cannot remain attached to anything. */
export function detachDeletedNote(notePath: string): void {
    getDb()
        .query("DELETE FROM note_links WHERE note_path = $path")
        .run({ $path: notePath })
}
