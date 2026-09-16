import {
    For,
    Loading,
    Show,
    createEffect,
    createMemo,
    createSignal,
    refresh,
} from "solid-js"
import type { Note, NotesWorkspaceInfo } from "@shared/types"
import { api, noteAssetUrl } from "../api"
import { renderMarkdown } from "../markdown"
import { PageSkeleton } from "../components/PageSkeleton"
import { ProductRail } from "../components/ProductRail"
import { PlusIcon } from "../components/icons"
import type { MainView } from "../types/navigation"
import layoutStyles from "../components/LibraryLayout.module.css"
import styles from "./NotesWorkspace.module.css"

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
    const [busy, setBusy] = createSignal(false)
    const [error, setError] = createSignal("")
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
    const create = async () => {
        if (!newTitle().trim()) return
        setBusy(true)
        setError("")
        try {
            const note = await api.createNote({
                title: newTitle().trim(),
                folder: folder() || undefined,
            })
            setCreating(false)
            setNewTitle("")
            refresh(listing)
            choose(note.path)
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught))
        } finally {
            setBusy(false)
        }
    }
    const initialise = async () => {
        setBusy(true)
        setError("")
        try {
            await api.initNotes()
            refresh(listing)
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught))
        } finally {
            setBusy(false)
        }
    }
    const sync = async () => {
        setBusy(true)
        setError("")
        try {
            await api.pullNotes()
            refresh(listing)
            refresh(selected)
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught))
        } finally {
            setBusy(false)
        }
    }
    const push = async () => {
        setBusy(true)
        setError("")
        try {
            await api.syncNotes(true)
            refresh(listing)
            refresh(selected)
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught))
        } finally {
            setBusy(false)
        }
    }

    return (
        <main
            class={`${layoutStyles.scope} ${styles.scope} app-shell min-h-screen text-slate-950 grid grid-cols-[220px_minmax(0,_1fr)] max-[820px]:block`}
        >
            <ProductRail active="notes" select={props.select} />
            <Loading fallback={<PageSkeleton />}>
                <Show when={listing()} keyed>
                    {(data) => (
                        <section class="library-surface min-w-0 p-[2.2rem_clamp(1.3rem,_3.5vw,_4.5rem)_4rem] max-[820px]:p-[1.25rem] max-[820px]:overflow-hidden">
                            <header class="library-header flex max-w-[1500px] items-start justify-between gap-[2rem] m-[0_auto_1.5rem] p-[1.5rem_clamp(1.25rem,_3vw,_3rem)_1.7rem] [&_h1]:m-[0.45rem_0_0] [&_p:last-child]:max-w-[62ch] [&_p:last-child]:m-[0.8rem_0_0] max-[560px]:block max-[560px]:p-[1.25rem]">
                                <div>
                                    <p class="eyebrow m-0">
                                        Reference workspace
                                    </p>
                                    <h1>Notes</h1>
                                    <p>
                                        Keep research, decisions and evidence in
                                        a versioned folder beside the work.
                                    </p>
                                </div>
                                <div class="library-header-actions flex flex-wrap items-center justify-end gap-[0.5rem] max-[560px]:mt-[1.25rem] max-[560px]:justify-start">
                                    <Show
                                        when={
                                            data.workspace.exists &&
                                            data.workspace.git.repo
                                        }
                                    >
                                        <button
                                            class="button inline-flex min-h-[2.5rem] items-center justify-center gap-[0.45rem] p-[0.5rem_0.9rem]"
                                            disabled={busy()}
                                            onClick={sync}
                                        >
                                            {busy() ? "Syncing…" : "Sync"}
                                        </button>
                                        <button
                                            class="button inline-flex min-h-[2.5rem] items-center justify-center gap-[0.45rem] p-[0.5rem_0.9rem]"
                                            disabled={
                                                busy() ||
                                                !data.workspace.git.upstream
                                            }
                                            title={
                                                data.workspace.git.upstream ??
                                                "No upstream configured for this repository."
                                            }
                                            onClick={push}
                                        >
                                            {busy() ? "Pushing…" : "Push"}
                                        </button>
                                    </Show>
                                    <button
                                        class="button-primary inline-flex min-h-[2.5rem] items-center justify-center gap-[0.45rem] p-[0.5rem_0.9rem]"
                                        disabled={
                                            !data.workspace.exists || busy()
                                        }
                                        onClick={() => setCreating(true)}
                                    >
                                        <PlusIcon />
                                        New note
                                    </button>
                                </div>
                            </header>
                            <Show when={error()}>
                                <p class="banner mb-5 p-[0.8rem_1rem]">
                                    {error()}
                                </p>
                            </Show>
                            <div class="library-layout grid grid-cols-[minmax(260px,_310px)_minmax(0,_1fr)] max-w-[1500px] min-h-[620px] m-[0_auto] max-[820px]:grid-cols-[1fr]">
                                <aside class="library-list flex min-w-0 flex-col">
                                    <label class="library-search grid gap-[0.45rem] p-[1rem] [&_input]:p-[0.58rem_0.65rem]">
                                        <span>Find a note</span>
                                        <input
                                            value={query()}
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
                                        }
                                    >
                                        <div class="library-filters [&_select]:p-[0.58rem_0.65rem] grid gap-[0.5rem] p-[0.75rem_1rem]">
                                            <Show
                                                when={data.folders.length > 0}
                                            >
                                                <select
                                                    value={folder()}
                                                    onChange={(event) =>
                                                        setFolder(
                                                            event.currentTarget
                                                                .value,
                                                        )
                                                    }
                                                >
                                                    <option value="">
                                                        All folders
                                                    </option>
                                                    <For each={data.folders}>
                                                        {(item) => (
                                                            <option
                                                                value={item}
                                                            >
                                                                {item}
                                                            </option>
                                                        )}
                                                    </For>
                                                </select>
                                            </Show>
                                            <Show when={data.tags.length > 0}>
                                                <select
                                                    value={tag()}
                                                    onChange={(event) =>
                                                        setTag(
                                                            event.currentTarget
                                                                .value,
                                                        )
                                                    }
                                                >
                                                    <option value="">
                                                        All tags
                                                    </option>
                                                    <For each={data.tags}>
                                                        {(item) => (
                                                            <option
                                                                value={item}
                                                            >
                                                                #{item}
                                                            </option>
                                                        )}
                                                    </For>
                                                </select>
                                            </Show>
                                        </div>
                                    </Show>
                                    <div class="note-list overflow-auto max-[820px]:flex max-[820px]:overflow-x-auto">
                                        <For
                                            each={data.notes}
                                            fallback={
                                                <p class="empty-copy p-4 m-[0.5rem_0_0] m-[0.5rem_0_0_1.05rem] ml-0">
                                                    {data.workspace.exists
                                                        ? "No notes match these filters."
                                                        : "The notes folder has not been created yet."}
                                                </p>
                                            }
                                        >
                                            {(item) => (
                                                <button
                                                    class={`note-list-item ${selectedPath() === item.path ? "note-list-active" : ""} block w-full p-[0.9rem_1rem] [&>span]:block [&_small]:block [&_strong]:block [&_strong]:mt-[0.25rem] [&_p]:line-clamp-2 [&_p]:m-[0.35rem_0] [&_p]:overflow-hidden max-[820px]:min-w-[13rem]`}
                                                    onClick={() =>
                                                        choose(item.path)
                                                    }
                                                >
                                                    <span>
                                                        {item.folder
                                                            ? `${item.folder}/`
                                                            : "Note"}
                                                    </span>
                                                    <strong>
                                                        {item.title}
                                                    </strong>
                                                    <p>
                                                        {item.excerpt ||
                                                            "No preview yet."}
                                                    </p>
                                                    <small>
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
                                        busy={busy()}
                                        initialise={initialise}
                                    />
                                </aside>
                                <section class="note-detail-pane min-w-0">
                                    <Show
                                        when={creating()}
                                        fallback={
                                            <Loading
                                                fallback={
                                                    <PageSkeleton compact />
                                                }
                                            >
                                                <Show
                                                    when={selected()}
                                                    keyed
                                                    fallback={
                                                        <div class="library-empty max-w-[48ch] m-[6rem_auto] p-[0_2rem] [&_h2]:m-0 [&_p]:m-[0.75rem_0_0]">
                                                            <h2>
                                                                Choose a note
                                                            </h2>
                                                            <p>
                                                                Select a note to
                                                                read or edit it.
                                                                Notes remain
                                                                ordinary
                                                                Markdown files
                                                                in the shared
                                                                folder.
                                                            </p>
                                                        </div>
                                                    }
                                                >
                                                    {(note) => (
                                                        <NoteEditor
                                                            note={note}
                                                            mode={noteMode()}
                                                            setMode={
                                                                setNoteMode
                                                            }
                                                            saved={async () => {
                                                                await refresh(
                                                                    selected,
                                                                )
                                                                await refresh(
                                                                    listing,
                                                                )
                                                            }}
                                                            close={() =>
                                                                setSelectedPath(
                                                                    "",
                                                                )
                                                            }
                                                        />
                                                    )}
                                                </Show>
                                            </Loading>
                                        }
                                    >
                                        <div class="editor-panel max-w-[980px] p-[clamp(1.25rem,_3vw,_3rem)] m-[2rem] [&_h2]:m-[0_0_1.25rem]">
                                            <h2>New note</h2>
                                            <label class="field grid gap-[0.45rem] [&_input]:w-full [&_input]:p-[0.68rem_0.75rem] [&_select]:w-full [&_select]:p-[0.68rem_0.75rem] [&_textarea]:w-full [&_textarea]:p-[0.68rem_0.75rem] [&_textarea]:min-h-[7rem]">
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
                                                    class="button inline-flex min-h-[2.5rem] items-center justify-center gap-[0.45rem] p-[0.5rem_0.9rem]"
                                                    onClick={() =>
                                                        setCreating(false)
                                                    }
                                                >
                                                    Cancel
                                                </button>
                                                <button
                                                    class="button-primary inline-flex min-h-[2.5rem] items-center justify-center gap-[0.45rem] p-[0.5rem_0.9rem]"
                                                    disabled={
                                                        !newTitle().trim() ||
                                                        busy()
                                                    }
                                                    onClick={create}
                                                >
                                                    Create note
                                                </button>
                                            </div>
                                        </div>
                                    </Show>
                                </section>
                            </div>
                        </section>
                    )}
                </Show>
            </Loading>
        </main>
    )
}

function NotesStatus(props: {
    workspace: NotesWorkspaceInfo
    busy: boolean
    initialise: () => Promise<void>
}) {
    return (
        <div class="notes-status mt-auto p-[1rem] [&_p]:m-[0_0_0.5rem] [&_p]:overflow-hidden max-[820px]:hidden">
            <p>{props.workspace.dir}</p>
            <Show
                when={!props.workspace.exists}
                fallback={
                    <>
                        <p>
                            {props.workspace.git.repo
                                ? `${props.workspace.git.branch ?? "Detached"} · ${props.workspace.git.dirty ? `${props.workspace.git.dirty} uncommitted` : "clean"}`
                                : "Not yet a Git repository"}
                        </p>
                    </>
                }
            >
                <p>The notes folder does not exist yet.</p>
                <button
                    class="button-primary inline-flex min-h-[2.5rem] items-center justify-center gap-[0.45rem] p-[0.5rem_0.9rem]"
                    disabled={props.busy}
                    onClick={props.initialise}
                >
                    Create folder
                </button>
            </Show>
        </div>
    )
}

function NoteEditor(props: {
    note: Note
    mode: "write" | "preview"
    setMode: (mode: "write" | "preview") => void
    saved: () => Promise<unknown>
    close: () => void
}) {
    const [title, setTitle] = createSignal(props.note.title)
    const [tags, setTags] = createSignal(props.note.tags.join(", "))
    const [body, setBody] = createSignal(props.note.body)
    const [busy, setBusy] = createSignal(false)
    const [error, setError] = createSignal("")
    let editor: HTMLTextAreaElement | undefined
    const noteInput = () => ({
        title: title().trim(),
        body: body(),
        tags: tags()
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean),
    })
    const preview = () =>
        renderMarkdown(body(), {
            resolveLink: (href) => noteAssetUrl(props.note.path, href),
        })
    const applySavedNote = (note: Note) => {
        setTitle(note.title)
        setTags(note.tags.join(", "))
        setBody(note.body)
    }
    const save = async () => {
        setBusy(true)
        setError("")
        try {
            applySavedNote(await api.updateNote(props.note.path, noteInput()))
            await props.saved()
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught))
        } finally {
            setBusy(false)
        }
    }
    const remove = async () => {
        if (!confirm(`Delete ${title()}?`)) return
        setBusy(true)
        try {
            await api.deleteNote(props.note.path)
            props.close()
            await props.saved()
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught))
        } finally {
            setBusy(false)
        }
    }

    const insertAtCursor = (markdown: string): string => {
        const start = editor?.selectionStart ?? body().length
        const end = editor?.selectionEnd ?? start
        const before = body().slice(0, start)
        const after = body().slice(end)
        const next = `${before}${before && !before.endsWith("\n") ? "\n\n" : ""}${markdown}\n${after}`
        setBody(next)
        const caret = next.length - after.length
        requestAnimationFrame(() => {
            editor?.focus()
            editor?.setSelectionRange(caret, caret)
        })
        return next
    }

    const pasteImages = async (event: ClipboardEvent) => {
        const images = [...(event.clipboardData?.files ?? [])].filter((file) =>
            file.type.startsWith("image/"),
        )
        if (!images.length) return
        event.preventDefault()
        setBusy(true)
        setError("")
        try {
            // Attachments belong to a saved note. Save the current draft first so the
            // final update cannot replace text typed before the paste.
            await api.updateNote(props.note.path, noteInput())
            const uploaded = await api.uploadAttachments(
                props.note.path,
                images,
            )
            const nextBody = insertAtCursor(
                uploaded.added.map((item) => item.markdown).join("\n"),
            )
            applySavedNote(
                await api.updateNote(props.note.path, { body: nextBody }),
            )
            await props.saved()
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught))
        } finally {
            setBusy(false)
        }
    }

    return (
        <article class="note-editor max-[560px]:[&_header]:block max-[560px]:[&_header_.flex]:mt-[1rem] max-w-[980px] p-[clamp(1.25rem,_3vw,_3rem)] [&_header]:flex [&_header]:items-start [&_header]:justify-between [&_header]:gap-[1rem] [&_header]:pb-[1.25rem] [&_h2]:max-w-[25ch] [&_h2]:m-[0.4rem_0_0]">
            <header>
                <div>
                    <p class="note-path">{props.note.path}</p>
                    <h2>{title()}</h2>
                </div>
                <div class="flex flex-wrap gap-2">
                    <div
                        class="note-modes flex [&_button]:min-h-[2.5rem] [&_button]:p-[0.5rem_0.8rem]"
                        role="group"
                        aria-label="Note view"
                    >
                        <button
                            class={props.mode === "write" ? "active" : ""}
                            onClick={() => props.setMode("write")}
                        >
                            Write
                        </button>
                        <button
                            class={props.mode === "preview" ? "active" : ""}
                            onClick={() => props.setMode("preview")}
                        >
                            Preview
                        </button>
                    </div>
                    <button
                        class="button inline-flex min-h-[2.5rem] items-center justify-center gap-[0.45rem] p-[0.5rem_0.9rem]"
                        disabled={busy()}
                        onClick={remove}
                    >
                        Delete
                    </button>
                    <button
                        class="button-primary inline-flex min-h-[2.5rem] items-center justify-center gap-[0.45rem] p-[0.5rem_0.9rem]"
                        disabled={!title().trim() || busy()}
                        onClick={save}
                    >
                        {busy() ? "Saving…" : "Save changes"}
                    </button>
                </div>
            </header>
            <Show when={error()}>
                <p class="banner mt-5 p-[0.8rem_1rem]">{error()}</p>
            </Show>
            <Show
                when={props.mode === "write"}
                fallback={
                    <div
                        class="note-rendered markdown min-h-[26rem] mt-[1.5rem] p-[clamp(1.25rem,_3vw,_2.25rem)] [&>:first-child]:mt-0 [&_h1]:m-[1.5em_0_0.55em] [&_h2]:m-[1.5em_0_0.55em] [&_h3]:m-[1.5em_0_0.55em] [&_h4]:m-[1.5em_0_0.55em] [&_p]:m-[0_0_1em] [&_code]:p-[0.1rem_0.32rem] [&_pre]:overflow-x-auto [&_pre]:p-[1rem] [&_pre_code]:p-0 [&_blockquote]:m-[0_0_1em] [&_blockquote]:pl-[1rem] [&_ul]:m-[0_0_1em] [&_ul]:pl-[1.5rem] [&_ol]:m-[0_0_1em] [&_ol]:pl-[1.5rem] [&_li.md-task]:ml-[-1.25rem] [&_li.md-task_input]:w-auto [&_li.md-task_input]:mr-[0.5rem] [&_img]:block [&_img]:max-w-full [&_img]:h-auto [&_img]:m-[1rem_0] [&_hr]:m-[1.5em_0] [&_.md-table-wrap]:overflow-x-auto [&_.md-table-wrap]:mb-[1em] [&_table]:min-w-full [&_th]:p-[0.45rem_0.7rem] [&_td]:p-[0.45rem_0.7rem]"
                        innerHTML={preview()}
                    />
                }
            >
                <div class="editor-fields grid gap-[1.1rem] mt-[1.5rem]">
                    <label class="field grid gap-[0.45rem] [&_input]:w-full [&_input]:p-[0.68rem_0.75rem] [&_select]:w-full [&_select]:p-[0.68rem_0.75rem] [&_textarea]:w-full [&_textarea]:p-[0.68rem_0.75rem] [&_textarea]:min-h-[7rem]">
                        <span>Title</span>
                        <input
                            value={title()}
                            onInput={(event) =>
                                setTitle(event.currentTarget.value)
                            }
                        />
                    </label>
                    <label class="field grid gap-[0.45rem] [&_input]:w-full [&_input]:p-[0.68rem_0.75rem] [&_select]:w-full [&_select]:p-[0.68rem_0.75rem] [&_textarea]:w-full [&_textarea]:p-[0.68rem_0.75rem] [&_textarea]:min-h-[7rem]">
                        <span>Tags</span>
                        <input
                            value={tags()}
                            onInput={(event) =>
                                setTags(event.currentTarget.value)
                            }
                            placeholder="research, decision"
                        />
                    </label>
                    <label class="field grid gap-[0.45rem] [&_input]:w-full [&_input]:p-[0.68rem_0.75rem] [&_select]:w-full [&_select]:p-[0.68rem_0.75rem] [&_textarea]:w-full [&_textarea]:p-[0.68rem_0.75rem] [&_textarea]:min-h-[7rem]">
                        <span>
                            Markdown — paste an image to attach and insert it
                            here
                        </span>
                        <textarea
                            ref={editor}
                            class="note-body !min-h-[26rem]"
                            value={body()}
                            onInput={(event) =>
                                setBody(event.currentTarget.value)
                            }
                            onPaste={pasteImages}
                        />
                    </label>
                </div>
            </Show>
        </article>
    )
}
