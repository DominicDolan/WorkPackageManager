import { For, Show, createMemo, createSignal } from "solid-js"
import type { NoteSummary } from "@shared/types"
import { api } from "../api"

/** Shared note picker for task and work package detail. The actual note stays in the
 * Notes workspace; this component only manages the reference to it. */
export function AttachedNotes(props: {
    notes: NoteSummary[]
    attach: (path: string) => Promise<unknown>
    detach: (path: string) => Promise<unknown>
    changed: () => void
    open: (path: string) => void
}) {
    const listing = createMemo(() => api.listNotes())
    const [selected, setSelected] = createSignal("")
    const [busy, setBusy] = createSignal("")
    const [error, setError] = createSignal("")
    const available = () => {
        const attached = new Set(props.notes.map((note) => note.path))
        return listing().notes.filter((note) => !attached.has(note.path))
    }
    const attach = async () => {
        const path = selected()
        if (!path) return
        setBusy(path)
        setError("")
        try {
            await props.attach(path)
            setSelected("")
            props.changed()
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught))
        } finally {
            setBusy("")
        }
    }
    const detach = async (path: string) => {
        setBusy(path)
        setError("")
        try {
            await props.detach(path)
            props.changed()
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught))
        } finally {
            setBusy("")
        }
    }

    return (
        <div class="attached-notes">
            <Show
                when={props.notes.length}
                fallback={
                    <p class="description">No reference notes attached.</p>
                }
            >
                <ul class="space-y-2">
                    <For each={props.notes}>
                        {(note) => (
                            <li class="flex items-start gap-3 tonal p-3">
                                <button
                                    class="min-w-0 flex-1 text-left"
                                    onClick={() => props.open(note.path)}
                                >
                                    <strong class="block truncate text-sm text-slate-800">
                                        {note.title}
                                    </strong>
                                    <span class="mt-1 block truncate caption muted">
                                        {note.path}
                                    </span>
                                    <Show when={note.excerpt}>
                                        <p class="mt-1 line-clamp-2 caption muted">
                                            {note.excerpt}
                                        </p>
                                    </Show>
                                </button>
                                <button
                                    class="outlined px-2 py-1 text-xs"
                                    disabled={!!busy()}
                                    aria-label={`Detach ${note.title}`}
                                    title="Detach note"
                                    onClick={() => detach(note.path)}
                                >
                                    Detach
                                </button>
                            </li>
                        )}
                    </For>
                </ul>
            </Show>
            <Show
                when={listing().workspace.exists}
                fallback={
                    <p class="mt-3 caption muted">
                        Create the notes workspace before attaching reference
                        material.
                    </p>
                }
            >
                <div class="mt-3 flex gap-2">
                    <select
                        class="min-w-0 flex-1 w-full p-[0.68rem_0.75rem]"
                        value={selected()}
                        disabled={!available().length || !!busy()}
                        onChange={(event) =>
                            setSelected(event.currentTarget.value)
                        }
                    >
                        <option value="">
                            {available().length
                                ? "Choose a note…"
                                : "All notes attached"}
                        </option>
                        <For each={available()}>
                            {(note) => (
                                <option value={note.path}>{note.title}</option>
                            )}
                        </For>
                    </select>
                    <button
                        class="outlined"
                        disabled={!selected() || !!busy()}
                        onClick={attach}
                    >
                        {busy() && busy() === selected()
                            ? "Attaching…"
                            : "Attach"}
                    </button>
                </div>
            </Show>
            <Show when={error()}>
                <p class="notice error mt-3">{error()}</p>
            </Show>
        </div>
    )
}
