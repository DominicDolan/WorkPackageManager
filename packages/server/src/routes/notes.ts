import {
    addAttachment,
    createNote,
    deleteNote,
    indexImageFolders,
    initNotes,
    listNoteListing,
    notesWorkspaceInfo,
    pullNotes,
    readNote,
    removeAttachment,
    resolveNoteAsset,
    resolveNoteLink,
    syncNotes,
    updateNote,
} from "@work-task-manager/core/notes"
import { created, fail, file } from "../http"
import { route } from "../router"
import { parseTags, uploadedFiles } from "./parse"

/**
 * Notes are files, so these routes are thin: read the folder, write the folder,
 * and let `notes.ts` do the resolving. A note's path is its identity and
 * contains slashes, so it travels as one percent-encoded segment.
 */
export const noteRoutes = [
    route(
        "GET",
        "/notes",
        "The notes list with its folders and tags, filtered by tag, folder or q.",
        ({ query }) => {
            // Folders of loose images get a note before the list is read, so images
            // added by hand show up on the next refresh. It only ever creates.
            indexImageFolders()
            return {
                ...listNoteListing({
                    tag: query.get("tag") ?? undefined,
                    folder: query.get("folder") ?? undefined,
                    search: query.get("q") ?? undefined,
                }),
                workspace: notesWorkspaceInfo(),
            }
        },
    ),

    route("POST", "/notes", "Create a note.", async ({ body }) => {
        const input = await body<{
            title?: string
            folder?: string
            path?: string
            body?: string
            tags?: unknown
        }>()
        if (!input.title?.trim()) return fail("A note needs a title.")
        return created({
            note: createNote({
                title: input.title,
                folder: input.folder,
                path: input.path,
                body: input.body,
                tags: parseTags(input.tags),
            }),
        })
    }),

    // Named rather than pathed, so it cannot collide with a note (those end `.md`).
    route(
        "GET",
        "/notes/asset",
        "Stream a file from the notes folder (?path=, or ?note=&href= as written in the note).",
        ({ query }) => {
            const note = query.get("note")
            const href = query.get("href")
            const path =
                note && href ? resolveNoteLink(note, href) : query.get("path")
            if (!path) return fail("An asset path is required.")
            const absolute = resolveNoteAsset(path)
            if (!absolute)
                return fail("No such file inside the notes folder.", 404)
            return file(absolute, "private, max-age=300")
        },
    ),

    route(
        "POST",
        "/notes/init",
        "Make the notes folder a Git repository.",
        () => ({
            init: initNotes(),
            workspace: notesWorkspaceInfo(),
        }),
    ),

    route("POST", "/notes/pull", "Pull the notes repository.", () => ({
        ...pullNotes(),
        workspace: notesWorkspaceInfo(),
    })),

    route(
        "POST",
        "/notes/sync",
        "Commit notes changes, and push when asked.",
        async ({ bodyOr }) => {
            const input = await bodyOr<{ push?: boolean; message?: string }>({})
            return syncNotes({
                push: input.push ?? false,
                message: input.message,
            })
        },
    ),

    route("GET", "/notes/:path", "One note.", ({ params }) => ({
        note: readNote(params.path!),
    })),

    route(
        "PATCH",
        "/notes/:path",
        "Edit a note's title, body, tags or path.",
        async ({ params, body }) => {
            const input = await body<{
                title?: string
                body?: string
                tags?: unknown
                path?: string
            }>()
            return {
                note: updateNote(params.path!, {
                    title: input.title,
                    body: input.body,
                    tags: parseTags(input.tags),
                    path: input.path,
                }),
            }
        },
    ),

    route("DELETE", "/notes/:path", "Delete a note.", ({ params }) => ({
        deleted: deleteNote(params.path!),
    })),

    route(
        "POST",
        "/notes/:path/attachments",
        "Attach files to a note (multipart, field `file`).",
        async ({ params, request }) => {
            const path = params.path!
            const added = []
            for (const one of await uploadedFiles(request))
                added.push(
                    addAttachment(
                        path,
                        one.name || "attachment",
                        await one.arrayBuffer(),
                    ),
                )
            return created({ added, note: readNote(path) })
        },
    ),

    route(
        "DELETE",
        "/notes/:path/attachments/:name",
        "Remove one attachment from a note.",
        ({ params }) => {
            removeAttachment(params.path!, params.name!)
            return { note: readNote(params.path!) }
        },
    ),
]
