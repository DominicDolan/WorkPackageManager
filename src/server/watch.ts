import { existsSync, watch, type FSWatcher } from "node:fs"
import { basename, dirname, join } from "node:path"
import { workspace } from "../config/paths"
import type { ChangeChannel, ChangeEvent } from "../shared/types"

/**
 * Telling open tabs that something changed underneath them.
 *
 * The whole premise of this tool is that the CLI, an agent and the web UI are
 * three ways into the same workspace — so the browser is routinely looking at
 * data that another process has just rewritten. `tasks done T-1` in a terminal,
 * or a `/work-task` run filing a note, used to leave the tab quietly stale until
 * somebody clicked something.
 *
 * There is nothing to subscribe to in SQLite or in a folder of Markdown, so this
 * watches what they actually are: files. Two channels, because the app has two
 * stores behind it —
 *
 * - **tasks** — the database. Tasks, investigations, delivery branches, agent
 *   runs. WAL mode means a write lands in `tasks.db-wal` rather than the
 *   database file, so the *directory* is watched and the names filtered.
 * - **notes** — the notes folder, which backs both the Notes view and Issues
 *   (the issue JSON files live there).
 *
 * Writes made through this server fire these watchers too, which is what keeps
 * two open tabs in step with each other and not just with the CLI.
 */

const ws = workspace()

/** Coalescing window. A single SQLite commit touches several files. */
const DEBOUNCE_MS = 250

type Listener = (event: ChangeEvent) => void

const listeners = new Set<Listener>()

/** Monotonic per channel. A client that reconnects compares what it last saw
 *  with what the stream hands it on connect, and reloads if it missed a beat. */
const revisions: Record<ChangeChannel, number> = { tasks: 0, notes: 0 }

const timers: Partial<Record<ChangeChannel, ReturnType<typeof setTimeout>>> = {}

export function currentRevisions(): Record<ChangeChannel, number> {
    return { ...revisions }
}

/** Record a change and tell every open stream, at most once per window. */
function bump(channel: ChangeChannel): void {
    if (timers[channel]) return
    timers[channel] = setTimeout(() => {
        delete timers[channel]
        revisions[channel] += 1
        const event: ChangeEvent = {
            channel,
            revision: revisions[channel],
            at: new Date().toISOString(),
        }
        for (const listener of listeners) {
            try {
                listener(event)
            } catch {
                // A stream that has gone away must not take the others with it.
            }
        }
    }, DEBOUNCE_MS)
}

/**
 * Announce a change this process made.
 *
 * The file watchers catch the same writes, so this is belt and braces — but a
 * watcher can be missing (a folder that did not exist at startup) or silent (a
 * network or container filesystem with no inotify), and a UI that only updates
 * on some machines is worse than one that never does.
 */
export function announceChange(channel: ChangeChannel): void {
    bump(channel)
}

/* --------------------------------------------------------------- watchers */

const watchers = new Map<string, FSWatcher>()

function attach(
    path: string,
    recursive: boolean,
    handler: (filename: string) => void,
): void {
    if (watchers.has(path) || !existsSync(path)) return

    try {
        const watcher = watch(
            path,
            { recursive, persistent: false },
            (_event, filename) => {
                handler(typeof filename === "string" ? filename : "")
            },
        )
        // A watched folder that is deleted or replaced (a notes folder re-cloned,
        // say) must not leave a dead watcher blocking a later re-attach.
        watcher.on("error", () => {
            watcher.close()
            watchers.delete(path)
        })
        watchers.set(path, watcher)
    } catch {
        // Recursive watching is not available everywhere. Without it the folder
        // simply goes unwatched; `announceChange` still covers writes made here.
    }
}

/** How often to look for a folder that did not exist last time. */
const RETRY_MS = 10_000

let retry: ReturnType<typeof setInterval> | undefined

/**
 * Attach whatever can be attached, now.
 *
 * Both folders can appear after the server does — `tasks notes init` creates the
 * notes folder, from the CLI as often as from here — so a missing one is
 * retried on a timer rather than written off. The timer only runs while a
 * folder is actually missing and somebody is listening.
 */
export function ensureWatchers(): void {
    const dataDir = dirname(ws.dbPath)
    const dbName = basename(ws.dbPath)

    attach(dataDir, false, (filename) => {
        // `tasks.db`, `tasks.db-wal`, `tasks.db-shm` — and nothing else in there,
        // which is also where PR bodies and agent logs are staged.
        if (filename.startsWith(dbName)) bump("tasks")
    })

    attach(ws.notesDir, true, (filename) => {
        // Notes are `.md`, issues are `.json`, attachments are whatever was dropped.
        // Git's own churn inside `.git/` is not a change to anything on screen.
        if (filename.startsWith(".git/") || filename.startsWith(".git\\"))
            return
        bump("notes")
    })

    const complete = watchers.has(dataDir) && watchers.has(ws.notesDir)
    if (complete || !listeners.size) {
        if (retry) {
            clearInterval(retry)
            retry = undefined
        }
        return
    }

    if (!retry) {
        retry = setInterval(ensureWatchers, RETRY_MS)
        // Two `existsSync` calls every ten seconds is not a reason to keep a process
        // alive on its own.
        retry.unref?.()
    }
}

/** Subscribe to changes. The returned function unsubscribes. */
export function onChange(listener: Listener): () => void {
    // Added first: `ensureWatchers` only schedules its retry while somebody is
    // listening, and this listener is the reason to start looking again.
    listeners.add(listener)
    ensureWatchers()
    return () => listeners.delete(listener)
}

/** How many streams are currently attached — reported by `/api/meta`. */
export function listenerCount(): number {
    return listeners.size
}

/** Where the notes watcher points, for diagnostics. */
export const watchedPaths = (): string[] => [
    dirname(ws.dbPath),
    join(ws.notesDir),
]
