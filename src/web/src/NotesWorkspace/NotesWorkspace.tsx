import type { GitConflict, Note } from "@shared/types"
import {
    action,
    createOptimistic,
    For,
    Loading,
    Show,
    createEffect,
    createMemo,
    createSignal,
    refresh,
    isPending,
    latest,
} from "solid-js"
import { api } from "../api"
import { useError } from "../hooks/useError"
import { ConflictAgentDialog } from "../components/ConflictAgentDialog"
import { PageSkeleton } from "../components/PageSkeleton"
import { ProductRail } from "../components/ProductRail"
import { PlusIcon } from "../components/icons"
import type { MainView } from "../types/navigation"
import { NoteEditor } from "./NoteEditor"
import { NotesStatus } from "./NotesStatus"

export function NotesWorkspace(props: {
    select: (view: MainView) => void
    initialPath?: string
    revision: number
}) {
    const [query, setQuery] = createSignal("")
    const [folder, setFolder] = createSignal("")
    const [tag, setTag] = createSignal("")
    const [selectedPath, setSelectedPath] = createSignal(
        props.initialPath ?? "",
    )
    const [noteMode, setNoteMode] = createSignal<"write" | "preview">("preview")
    const [creating, setCreating] = createSignal(false)
    const [newTitle, setNewTitle] = createSignal("")
    const [busy, setBusy] = createOptimistic("")
    const { capture, clear, Banner } = useError()
    const [notice, setNotice] = createSignal("")
    const [conflict, setConflict] = createSignal<GitConflict | null>(null)
    const listing = createMemo(() =>
        api.listNotes({
            q: query() || undefined,
            folder: folder() || undefined,
            tag: tag() || undefined,
        }),
    )
    const selected = createMemo(async (): Promise<Note | null> =>
        selectedPath() ? api.getNote(selectedPath()) : null,
    )
    createEffect(
        () => props.revision,
        () => {
            refresh(listing)
            refresh(selected)
        },
    )

    const choose = (path: string) => {
        setSelectedPath(path)
        setNoteMode("preview")
        refresh(selected)
    }
    const create = action(async function* () {
        if (busy()) return

        if (!newTitle().trim()) return
        setBusy("create")
        clear()
        try {
            const note = await api.createNote({
                title: newTitle().trim(),
                folder: folder() || undefined,
            })
            yield
            setCreating(false)
            setNewTitle("")
            yield refresh(listing)
            choose(note.path)
        } catch (caught) {
            yield
            capture(caught)
        }
    })
    const initialise = action(function* () {
        if (busy()) return

        setBusy("initialise")
        clear()
        try {
            yield api.initNotes()

            yield refresh(listing)
        } catch (caught) {
            capture(caught)
        }
    })
    const sync = action(async function* () {
        if (busy()) return

        setBusy("sync")
        clear()
        setNotice("")
        try {
            const pulled = await api.pullNotes()
            yield
            if (pulled.conflict) {
                setConflict(pulled.conflict)
                return
            }
            if (pulled.merged)
                setNotice(
                    `Merged ${pulled.received} commit${pulled.received === 1 ? "" : "s"} from ${pulled.upstream}.`,
                )
            yield Promise.all([refresh(listing), refresh(selected)])
        } catch (caught) {
            yield
            capture(caught)
        }
    })
    const push = action(function* () {
        if (busy()) return

        setBusy("push")
        clear()
        try {
            yield api.syncNotes(true)

            yield refresh(listing)
            yield refresh(selected)
        } catch (caught) {
            capture(caught)
        }
    })

    return (
        <main class="app-shell min-h-screen text-slate-950 grid grid-cols-[220px_minmax(0,_1fr)] max-[820px]:block">
            <ProductRail active="notes" select={props.select} />
            <Loading fallback={<PageSkeleton />}>
                <Show when={listing()} keyed>
                    {(data) => (
                        <section class="library-surface min-w-0 p-[2.2rem_clamp(1.3rem,_3.5vw,_4.5rem)_4rem] max-[820px]:p-[1.25rem] max-[820px]:overflow-hidden">
                            <header class="library flex max-w-[1500px] items-start justify-between gap-[2rem] m-[0_auto_1.5rem] p-[1.5rem_clamp(1.25rem,_3vw,_3rem)_1.7rem] max-[560px]:block max-[560px]:p-[1.25rem]">
                                <div>
                                    <p class="eyebrow m-0">
                                        Reference workspace
                                    </p>
                                    <h1 class="m-[0.45rem_0_0]">Notes</h1>
                                    <p class="max-w-[62ch] m-[0.8rem_0_0]">
                                        Keep research, decisions and evidence in
                                        a versioned folder beside the work.
                                    </p>
                                </div>
                                <div class="flex flex-wrap items-center justify-end gap-[0.5rem] max-[560px]:mt-[1.25rem] max-[560px]:justify-start">
                                    <Show
                                        when={
                                            data.workspace.exists &&
                                            data.workspace.git.repo
                                        }>
                                        <button
                                            aria-busy={
                                                busy() === "sync"
                                                    ? "true"
                                                    : "false"
                                            }
                                            class="outlined"
                                            disabled={!!busy()}
                                            onClick={sync}>
                                            Sync
                                        </button>
                                        <button
                                            aria-busy={
                                                busy() === "push"
                                                    ? "true"
                                                    : "false"
                                            }
                                            class="outlined"
                                            disabled={
                                                !!busy() ||
                                                !data.workspace.git.upstream
                                            }
                                            title={
                                                data.workspace.git.upstream ??
                                                "No upstream configured for this repository."
                                            }
                                            onClick={push}>
                                            Push
                                        </button>
                                    </Show>
                                    <button
                                        class="primary"
                                        disabled={
                                            !data.workspace.exists || !!busy()
                                        }
                                        onClick={() => setCreating(true)}>
                                        <PlusIcon />
                                        New note
                                    </button>
                                </div>
                            </header>
                            <Banner />
                            <Show when={notice()}>
                                <p
                                    class="notice success max-w-[1500px] m-[0_auto_1rem]"
                                    role="status">
                                    {notice()}
                                </p>
                            </Show>
                            <Show when={conflict()} keyed>
                                {(found) => (
                                    <ConflictAgentDialog
                                        conflict={found}
                                        subject={{
                                            kind: "notes",
                                            ref: found.branch,
                                        }}
                                        close={() => setConflict(null)}
                                        started={(run) =>
                                            setNotice(
                                                run.mode === "terminal"
                                                    ? "An agent is resolving the notes merge in a terminal window. Sync again once it has finished."
                                                    : `An agent is resolving the notes merge (run #${run.id}). Sync again once it has finished.`,
                                            )
                                        }
                                    />
                                )}
                            </Show>
                            <section class="library grid grid-cols-[minmax(260px,_310px)_minmax(0,_1fr)] max-w-[1500px] min-h-[620px] m-[0_auto] max-[820px]:grid-cols-[1fr]">
                                <aside class="library flex min-w-0 flex-col">
                                    <label class="search grid gap-[0.45rem] p-[1rem]">
                                        <span>Find a note</span>
                                        <input
                                            class="p-[0.58rem_0.65rem]"
                                            value={latest(query)}
                                            onInput={(event) =>
                                                setQuery(
                                                    event.currentTarget.value,
                                                )
                                            }
                                            placeholder="Search notes"
                                            type="search"
                                        />
                                    </label>
                                    <Show
                                        when={
                                            data.folders.length > 0 ||
                                            data.tags.length > 0
                                        }>
                                        <div class="filters grid gap-[0.5rem] p-[0.75rem_1rem]">
                                            <Show
                                                when={data.folders.length > 0}>
                                                <select
                                                    class="p-[0.58rem_0.65rem]"
                                                    value={latest(folder)}
                                                    onChange={(event) =>
                                                        setFolder(
                                                            event.currentTarget
                                                                .value,
                                                        )
                                                    }>
                                                    <option value="">
                                                        All folders
                                                    </option>
                                                    <For each={data.folders}>
                                                        {(item) => (
                                                            <option
                                                                value={item}>
                                                                {item}
                                                            </option>
                                                        )}
                                                    </For>
                                                </select>
                                            </Show>
                                            <Show when={data.tags.length > 0}>
                                                <select
                                                    class="p-[0.58rem_0.65rem]"
                                                    value={latest(tag)}
                                                    onChange={(event) =>
                                                        setTag(
                                                            event.currentTarget
                                                                .value,
                                                        )
                                                    }>
                                                    <option value="">
                                                        All tags
                                                    </option>
                                                    <For each={data.tags}>
                                                        {(item) => (
                                                            <option
                                                                value={item}>
                                                                #{item}
                                                            </option>
                                                        )}
                                                    </For>
                                                </select>
                                            </Show>
                                        </div>
                                    </Show>
                                    <div
                                        aria-busy={
                                            isPending(listing)
                                                ? "true"
                                                : "false"
                                        }
                                        class="note-list overflow-auto max-[820px]:flex max-[820px]:overflow-x-auto">
                                        <For
                                            each={data.notes}
                                            fallback={
                                                <p class="caption muted p-4 m-[0.5rem_0_0] m-[0.5rem_0_0_1.05rem] ml-0">
                                                    {data.workspace.exists
                                                        ? "No notes match these filters."
                                                        : "The notes folder has not been created yet."}
                                                </p>
                                            }>
                                            {(item) => (
                                                <button
                                                    class={`card-item row compact block w-full p-[0.9rem_1rem] max-[820px]:min-w-[13rem]`}
                                                    aria-current={
                                                        latest(selectedPath) ===
                                                        item.path
                                                            ? "page"
                                                            : undefined
                                                    }
                                                    aria-busy={
                                                        latest(selectedPath) ===
                                                            item.path &&
                                                        isPending(selected)
                                                            ? "true"
                                                            : "false"
                                                    }
                                                    onClick={() =>
                                                        choose(item.path)
                                                    }>
                                                    <span class="block">
                                                        {item.folder
                                                            ? `${item.folder}/`
                                                            : "Note"}
                                                    </span>
                                                    <strong class="block mt-[0.25rem]">
                                                        {item.title}
                                                    </strong>
                                                    <p class="line-clamp-2 m-[0.35rem_0] overflow-hidden">
                                                        {item.excerpt ||
                                                            "No preview yet."}
                                                    </p>
                                                    <small class="block">
                                                        {item.tags
                                                            .map(
                                                                (value) =>
                                                                    `#${value}`,
                                                            )
                                                            .join(" ")}
                                                    </small>
                                                </button>
                                            )}
                                        </For>
                                    </div>
                                    <NotesStatus
                                        workspace={data.workspace}
                                        busy={!!busy()}
                                        initialising={busy() === "initialise"}
                                        initialise={initialise}
                                    />
                                </aside>
                                <section class="detail min-w-0">
                                    <Show
                                        when={creating()}
                                        fallback={
                                            <Loading
                                                fallback={
                                                    <PageSkeleton compact />
                                                }>
                                                <div
                                                    aria-busy={
                                                        isPending(selected)
                                                            ? "true"
                                                            : "false"
                                                    }
                                                    inert={isPending(selected)}>
                                                    <Show
                                                        when={selected()}
                                                        keyed
                                                        fallback={
                                                            <section class="empty max-w-[48ch] m-[6rem_auto] p-[0_2rem]">
                                                                <h2 class="m-0">
                                                                    Choose a
                                                                    note
                                                                </h2>
                                                                <p class="m-[0.75rem_0_0]">
                                                                    Select a
                                                                    note to read
                                                                    or edit it.
                                                                    Notes remain
                                                                    ordinary
                                                                    Markdown
                                                                    files in the
                                                                    shared
                                                                    folder.
                                                                </p>
                                                            </section>
                                                        }>
                                                        {(note) => (
                                                            <NoteEditor
                                                                note={note}
                                                                mode={noteMode()}
                                                                setMode={
                                                                    setNoteMode
                                                                }
                                                                saved={() =>
                                                                    Promise.all(
                                                                        [
                                                                            refresh(
                                                                                selected,
                                                                            ),
                                                                            refresh(
                                                                                listing,
                                                                            ),
                                                                        ],
                                                                    )
                                                                }
                                                                close={() =>
                                                                    setSelectedPath(
                                                                        "",
                                                                    )
                                                                }
                                                            />
                                                        )}
                                                    </Show>
                                                </div>
                                            </Loading>
                                        }>
                                        <article class="max-w-[980px] p-[clamp(1.25rem,_3vw,_3rem)] m-[2rem]">
                                            <h2 class="m-[0_0_1.25rem]">
                                                New note
                                            </h2>
                                            <label class="field">
                                                <span>Title</span>
                                                <input
                                                    autofocus
                                                    value={newTitle()}
                                                    onInput={(event) =>
                                                        setNewTitle(
                                                            event.currentTarget
                                                                .value,
                                                        )
                                                    }
                                                />
                                            </label>
                                            <div class="mt-5 flex gap-2">
                                                <button
                                                    class="outlined"
                                                    onClick={() =>
                                                        setCreating(false)
                                                    }>
                                                    Cancel
                                                </button>
                                                <button
                                                    class="primary"
                                                    disabled={
                                                        !newTitle().trim() ||
                                                        !!busy()
                                                    }
                                                    onClick={create}
                                                    aria-busy={
                                                        busy() === "create"
                                                            ? "true"
                                                            : "false"
                                                    }>
                                                    Create note
                                                </button>
                                            </div>
                                        </article>
                                    </Show>
                                </section>
                            </section>
                        </section>
                    )}
                </Show>
            </Loading>
        </main>
    )
}
