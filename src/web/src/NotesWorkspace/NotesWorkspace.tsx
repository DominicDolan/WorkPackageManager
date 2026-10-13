import { createQuery } from "../hooks/createQuery"
import {
    ISSUE_SOURCE_LABELS,
    VISUAL_NOTES_FOLDER,
    type GitConflict,
    type IssueDetail,
    type IssueState,
    type Note,
} from "@shared/types"
import {
    action,
    createMemo,
    createOptimistic,
    For,
    Loading,
    Show,
    createEffect,
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
import type { WorkItemKind } from "../components/AddToWorkPackage"
import { AddIssueDialog } from "../IssuesWorkspace/AddIssueDialog"
import { IssueDetailPane } from "../IssuesWorkspace/IssueDetailPane"
import { AddNoteDialog } from "./AddNoteDialog"
import { LibraryCard, type LibraryEntry } from "./LibraryCard"
import { NoteEditor } from "./NoteEditor"
import { NotesStatus } from "./NotesStatus"

type Shown = "all" | "notes" | "issues" | "vr"

const isVisualNote = (path: string) =>
    path === VISUAL_NOTES_FOLDER || path.startsWith(`${VISUAL_NOTES_FOLDER}/`)

/** Which record an Add as task / Add as investigation dialog was opened for. */
type AddRequest =
    | { from: "note"; path: string; kind: WorkItemKind }
    | { from: "issue"; id: string; kind: WorkItemKind }

/**
 * Notes and issues on one page, as one grid of cards, newest first. Both live
 * in the notes folder; notes are edited here, issues are only read.
 */
export function NotesWorkspace(props: {
    select: (view: MainView) => void
    openWorkPackage: (ref: string) => void
    initialPath?: string
    initialIssueId?: string
    revision: number
}) {
    const [query, setQuery] = createSignal("")
    const [shown, setShown] = createSignal<Shown>(
        isVisualNote(props.initialPath ?? "") ? "vr" : "all",
    )
    const [folder, setFolder] = createSignal("")
    const [tag, setTag] = createSignal("")
    const [state, setState] = createSignal<IssueState | "all">("all")
    const [source, setSource] = createSignal("")
    const [label, setLabel] = createSignal("")
    const [selectedPath, setSelectedPath] = createSignal(
        props.initialPath ?? "",
    )
    const [selectedIssueId, setSelectedIssueId] = createSignal(
        props.initialIssueId ?? "",
    )
    const [noteMode, setNoteMode] = createSignal<"write" | "preview">("preview")
    const [creating, setCreating] = createSignal(false)
    const [newTitle, setNewTitle] = createSignal("")
    // Held here rather than in each card, so opening a note and coming back
    // leaves the grid laid out as it was.
    const [expanded, setExpanded] = createSignal<ReadonlySet<string>>(new Set())
    const [busy, setBusy] = createOptimistic("")
    const { capture, clear, Banner } = useError()
    const [notice, setNotice] = createSignal("")
    const [conflict, setConflict] = createSignal<GitConflict | null>(null)
    const [adding, setAdding] = createSignal<AddRequest | null>(null)
    const [added, setAdded] = createSignal<{
        kind: WorkItemKind
        ref: string
        name: string
    } | null>(null)

    const notes = createQuery(() =>
        api.listNotes({
            q: query() || undefined,
            folder: folder() || undefined,
            tag: tag() || undefined,
        }),
    )
    const issues = createQuery(() =>
        api.listIssues({
            q: query() || undefined,
            state: state(),
            source: source() || undefined,
            label: label() || undefined,
        }),
    )
    const selectedNote = createQuery(async (): Promise<Note | null> =>
        selectedPath() ? api.getNote(selectedPath()) : null,
    )
    const selectedIssue = createQuery(async (): Promise<IssueDetail | null> =>
        selectedIssueId() ? api.getIssue(selectedIssueId()) : null,
    )
    createEffect(
        () => props.revision,
        () => {
            refresh(notes)
            refresh(issues)
            refresh(selectedNote)
            refresh(selectedIssue)
        },
    )

    const entries = createMemo((): LibraryEntry[] => {
        const noteEntries: LibraryEntry[] =
            shown() === "issues"
                ? []
                : notes.value.notes
                      .filter((note) =>
                          shown() === "vr"
                              ? isVisualNote(note.path)
                              : !isVisualNote(note.path),
                      )
                      .map((note) => ({
                          kind: "note",
                          key: `note:${note.path}`,
                          updatedAt: note.updatedAt,
                          note,
                      }))
        const issueEntries: LibraryEntry[] =
            shown() === "notes" || shown() === "vr"
                ? []
                : issues.value.issues.map((issue) => ({
                      kind: "issue",
                      key: `issue:${issue.id}`,
                      updatedAt:
                          issue.updatedAt ??
                          issue.createdAt ??
                          issue.fetchedAt ??
                          "",
                      issue,
                  }))
        return [...noteEntries, ...issueEntries].sort((left, right) =>
            right.updatedAt.localeCompare(left.updatedAt),
        )
    })
    const pending = () =>
        isPending(() => notes.value) || isPending(() => issues.value)

    // Filters that only mean something for one kind are cleared when that kind
    // is hidden, so nothing stays filtered by a control that is not shown.
    const show = (next: Shown) => {
        if (next === shown()) return
        setShown(next)
        setFolder("")
        setTag("")
        if (next !== "issues") {
            setState("all")
            setSource("")
            setLabel("")
        }
    }
    const toggle = (key: string) =>
        setExpanded((current) => {
            const next = new Set(current)
            if (!next.delete(key)) next.add(key)
            return next
        })
    const openNote = (path: string) => {
        setSelectedIssueId("")
        setSelectedPath(path)
        setNoteMode("preview")
        refresh(selectedNote)
    }
    const openIssue = (id: string) => {
        setSelectedPath("")
        setSelectedIssueId(id)
        refresh(selectedIssue)
    }
    const add = (request: AddRequest) => {
        setAdded(null)
        setAdding(request)
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
            yield refresh(notes)
            openNote(note.path)
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

            yield Promise.all([refresh(notes), refresh(issues)])
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
            yield Promise.all([
                refresh(notes),
                refresh(issues),
                refresh(selectedNote),
                refresh(selectedIssue),
            ])
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

            yield Promise.all([refresh(notes), refresh(selectedNote)])
        } catch (caught) {
            capture(caught)
        }
    })

    return (
        <main class="app-shell min-h-screen text-slate-950 grid grid-cols-[220px_minmax(0,_1fr)] max-[820px]:block">
            <ProductRail active="notes" select={props.select} />
            <Loading fallback={<PageSkeleton />}>
                <Show when={notes.value && issues.value}>
                    <section class="library-surface min-w-0 p-[2.2rem_clamp(1.3rem,_3.5vw,_4.5rem)_4rem] max-[820px]:p-[1.25rem] max-[820px]:overflow-hidden">
                        <header class="library flex max-w-[1500px] items-start justify-between gap-[2rem] m-[0_auto_1.5rem] p-[1.5rem_clamp(1.25rem,_3vw,_3rem)_1.7rem] max-[560px]:block max-[560px]:p-[1.25rem]">
                            <div>
                                <p class="eyebrow m-0">Reference workspace</p>
                                <h1 class="m-[0.45rem_0_0]">Notes & issues</h1>
                                <p class="max-w-[62ch] m-[0.8rem_0_0]">
                                    Research, decisions and imported issues, in
                                    a versioned folder beside the work. Issues
                                    are read-only here.
                                </p>
                            </div>
                            <div class="flex flex-wrap items-center justify-end gap-[0.5rem] max-[560px]:mt-[1.25rem] max-[560px]:justify-start">
                                <Show
                                    when={
                                        notes.value.workspace.exists &&
                                        notes.value.workspace.git.repo
                                    }>
                                    <button
                                        aria-busy={
                                            busy() === "sync" ? "true" : "false"
                                        }
                                        class="outlined"
                                        disabled={!!busy()}
                                        onClick={sync}>
                                        Sync
                                    </button>
                                    <button
                                        aria-busy={
                                            busy() === "push" ? "true" : "false"
                                        }
                                        class="outlined"
                                        disabled={
                                            !!busy() ||
                                            !notes.value.workspace.git.upstream
                                        }
                                        title={
                                            notes.value.workspace.git
                                                .upstream ??
                                            "No upstream configured for this repository."
                                        }
                                        onClick={push}>
                                        Push
                                    </button>
                                </Show>
                                <Show when={shown() !== "vr"}>
                                    <button
                                        class="primary"
                                        disabled={
                                            !notes.value.workspace.exists ||
                                            !!busy()
                                        }
                                        onClick={() => setCreating(true)}>
                                        <PlusIcon />
                                        New note
                                    </button>
                                </Show>
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
                        <Show when={added()} keyed>
                            {(done) => (
                                <p
                                    class="notice success flex max-w-[1500px] flex-wrap items-center justify-between gap-[0.75rem] m-[0_auto_1rem]"
                                    role="status">
                                    <span>
                                        Added as{" "}
                                        {done.kind === "task"
                                            ? "a task"
                                            : "an investigation"}{" "}
                                        to {done.ref} · {done.name}.
                                    </span>
                                    <button
                                        class="outlined"
                                        onClick={() =>
                                            props.openWorkPackage(done.ref)
                                        }>
                                        Open work package
                                    </button>
                                </p>
                            )}
                        </Show>
                        <Show when={adding()} keyed>
                            {(request) => {
                                const close = () => setAdding(null)
                                const done = (workPackage: {
                                    ref: string
                                    name: string
                                }) => {
                                    setAdding(null)
                                    setAdded({
                                        kind: request.kind,
                                        ...workPackage,
                                    })
                                }
                                return request.from === "note" ? (
                                    <AddNoteDialog
                                        path={request.path}
                                        kind={request.kind}
                                        close={close}
                                        added={done}
                                    />
                                ) : (
                                    <AddIssueDialog
                                        issueId={request.id}
                                        kind={request.kind}
                                        close={close}
                                        added={done}
                                    />
                                )
                            }}
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
                        <Show
                            when={creating()}
                            fallback={
                                <Loading fallback={<PageSkeleton compact />}>
                                    <Show
                                        when={selectedNote.value}
                                        keyed
                                        fallback={
                                            <Show
                                                when={selectedIssue.value}
                                                keyed
                                                fallback={
                                                    <Library
                                                        entries={entries()}
                                                        notes={notes.value}
                                                        issues={issues.value}
                                                        pending={pending()}
                                                        query={latest(query)}
                                                        setQuery={setQuery}
                                                        shown={latest(shown)}
                                                        show={show}
                                                        folder={latest(folder)}
                                                        setFolder={setFolder}
                                                        tag={latest(tag)}
                                                        setTag={setTag}
                                                        state={latest(state)}
                                                        setState={setState}
                                                        source={latest(source)}
                                                        setSource={setSource}
                                                        label={latest(label)}
                                                        setLabel={setLabel}
                                                        expanded={expanded()}
                                                        toggle={toggle}
                                                        opening={(entry) =>
                                                            entry.kind ===
                                                            "note"
                                                                ? latest(
                                                                      selectedPath,
                                                                  ) ===
                                                                      entry.note
                                                                          .path &&
                                                                  isPending(
                                                                      () =>
                                                                          selectedNote.value,
                                                                  )
                                                                : latest(
                                                                      selectedIssueId,
                                                                  ) ===
                                                                      entry
                                                                          .issue
                                                                          .id &&
                                                                  isPending(
                                                                      () =>
                                                                          selectedIssue.value,
                                                                  )
                                                        }
                                                        open={(entry) =>
                                                            entry.kind ===
                                                            "note"
                                                                ? openNote(
                                                                      entry.note
                                                                          .path,
                                                                  )
                                                                : openIssue(
                                                                      entry
                                                                          .issue
                                                                          .id,
                                                                  )
                                                        }
                                                        add={(entry, kind) =>
                                                            add(
                                                                entry.kind ===
                                                                    "note"
                                                                    ? {
                                                                          from: "note",
                                                                          path: entry
                                                                              .note
                                                                              .path,
                                                                          kind,
                                                                      }
                                                                    : {
                                                                          from: "issue",
                                                                          id: entry
                                                                              .issue
                                                                              .id,
                                                                          kind,
                                                                      },
                                                            )
                                                        }
                                                        busy={!!busy()}
                                                        initialising={
                                                            busy() ===
                                                            "initialise"
                                                        }
                                                        initialise={initialise}
                                                    />
                                                }>
                                                {(issue) => (
                                                    <section
                                                        class="library detail max-w-[1500px] m-[0_auto] min-w-0"
                                                        inert={isPending(
                                                            () =>
                                                                selectedIssue.value,
                                                        )}>
                                                        <IssueDetailPane
                                                            issue={issue}
                                                            back={() =>
                                                                setSelectedIssueId(
                                                                    "",
                                                                )
                                                            }
                                                            add={(kind) =>
                                                                add({
                                                                    from: "issue",
                                                                    id: issue.id,
                                                                    kind,
                                                                })
                                                            }
                                                        />
                                                    </section>
                                                )}
                                            </Show>
                                        }>
                                        {(note) => (
                                            <section
                                                class="library detail max-w-[1500px] m-[0_auto] min-w-0"
                                                inert={isPending(
                                                    () => selectedNote.value,
                                                )}>
                                                <NoteEditor
                                                    note={note}
                                                    mode={noteMode()}
                                                    setMode={setNoteMode}
                                                    saved={() =>
                                                        Promise.all([
                                                            refresh(
                                                                selectedNote,
                                                            ),
                                                            refresh(notes),
                                                        ])
                                                    }
                                                    close={() =>
                                                        setSelectedPath("")
                                                    }
                                                    add={(kind) =>
                                                        add({
                                                            from: "note",
                                                            path: note.path,
                                                            kind,
                                                        })
                                                    }
                                                />
                                            </section>
                                        )}
                                    </Show>
                                </Loading>
                            }>
                            <section class="library detail max-w-[1500px] m-[0_auto] min-w-0">
                                <article class="max-w-[980px] p-[clamp(1.25rem,_3vw,_3rem)] m-[2rem]">
                                    <h2 class="m-[0_0_1.25rem]">New note</h2>
                                    <label class="field">
                                        <span>Title</span>
                                        <input
                                            autofocus
                                            value={newTitle()}
                                            onInput={(event) =>
                                                setNewTitle(
                                                    event.currentTarget.value,
                                                )
                                            }
                                        />
                                    </label>
                                    <div class="mt-5 flex gap-2">
                                        <button
                                            class="outlined"
                                            onClick={() => setCreating(false)}>
                                            Cancel
                                        </button>
                                        <button
                                            class="primary"
                                            disabled={
                                                !newTitle().trim() || !!busy()
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
                            </section>
                        </Show>
                    </section>
                </Show>
            </Loading>
        </main>
    )
}

/** The filters and the grid of cards. */
function Library(props: {
    entries: LibraryEntry[]
    notes: Awaited<ReturnType<typeof api.listNotes>>
    issues: Awaited<ReturnType<typeof api.listIssues>>
    pending: boolean
    query: string
    setQuery: (value: string) => void
    shown: Shown
    show: (value: Shown) => void
    folder: string
    setFolder: (value: string) => void
    tag: string
    setTag: (value: string) => void
    state: IssueState | "all"
    setState: (value: IssueState | "all") => void
    source: string
    setSource: (value: string) => void
    label: string
    setLabel: (value: string) => void
    expanded: ReadonlySet<string>
    toggle: (key: string) => void
    opening: (entry: LibraryEntry) => boolean
    open: (entry: LibraryEntry) => void
    add: (entry: LibraryEntry, kind: WorkItemKind) => void
    busy: boolean
    initialising: boolean
    initialise: () => Promise<void>
}) {
    const folders = createMemo(() =>
        props.notes.folders.filter((item) =>
            props.shown === "vr" ? isVisualNote(item) : !isVisualNote(item),
        ),
    )
    return (
        <>
            <section class="library flex max-w-[1500px] flex-wrap items-center gap-[0.75rem] m-[0_auto_1.25rem] p-[0.85rem_1rem]">
                <input
                    class="min-w-[14rem] flex-1 p-[0.58rem_0.65rem]"
                    aria-label="Search notes and issues"
                    value={props.query}
                    onInput={(event) =>
                        props.setQuery(event.currentTarget.value)
                    }
                    placeholder="Search notes and issues"
                    type="search"
                />
                <div role="group" class="segmented flex" aria-label="Show">
                    <For each={["all", "notes", "issues", "vr"] as const}>
                        {(value) => (
                            <button
                                class="p-[0.5rem_0.8rem]"
                                aria-pressed={
                                    props.shown === value ? "true" : "false"
                                }
                                onClick={() => props.show(value)}>
                                {value === "all"
                                    ? "All"
                                    : value === "notes"
                                      ? "Notes"
                                      : value === "issues"
                                        ? "Issues"
                                        : "VR notes"}
                            </button>
                        )}
                    </For>
                </div>
                <Show
                    when={
                        (props.shown === "notes" || props.shown === "vr") &&
                        folders().length
                    }>
                    <select
                        class="p-[0.58rem_0.65rem]"
                        aria-label="Folder"
                        value={props.folder}
                        onChange={(event) =>
                            props.setFolder(event.currentTarget.value)
                        }>
                        <option value="">
                            {props.shown === "vr"
                                ? "All VR folders"
                                : "All folders"}
                        </option>
                        <For each={folders()}>
                            {(item) => (
                                <option value={item}>
                                    {props.shown === "vr"
                                        ? item.slice(
                                              VISUAL_NOTES_FOLDER.length + 1,
                                          )
                                        : item}
                                </option>
                            )}
                        </For>
                    </select>
                </Show>
                <Show when={props.shown === "notes" && props.notes.tags.length}>
                    <select
                        class="p-[0.58rem_0.65rem]"
                        aria-label="Tag"
                        value={props.tag}
                        onChange={(event) =>
                            props.setTag(event.currentTarget.value)
                        }>
                        <option value="">All tags</option>
                        <For each={props.notes.tags}>
                            {(item) => <option value={item}>#{item}</option>}
                        </For>
                    </select>
                </Show>
                <Show when={props.shown === "issues"}>
                    <select
                        class="p-[0.58rem_0.65rem]"
                        aria-label="State"
                        value={props.state}
                        onChange={(event) =>
                            props.setState(
                                event.currentTarget.value as IssueState | "all",
                            )
                        }>
                        <option value="all">All states</option>
                        <option value="open">Open</option>
                        <option value="closed">Closed</option>
                    </select>
                    <Show when={props.issues.facets.sources.length > 1}>
                        <select
                            class="p-[0.58rem_0.65rem]"
                            aria-label="Source"
                            value={props.source}
                            onChange={(event) =>
                                props.setSource(event.currentTarget.value)
                            }>
                            <option value="">All sources</option>
                            <For each={props.issues.facets.sources}>
                                {(item) => (
                                    <option value={item.source}>
                                        {ISSUE_SOURCE_LABELS[item.source] ??
                                            item.source}{" "}
                                        ({item.count})
                                    </option>
                                )}
                            </For>
                        </select>
                    </Show>
                    <Show when={props.issues.facets.labels.length}>
                        <select
                            class="p-[0.58rem_0.65rem]"
                            aria-label="Label"
                            value={props.label}
                            onChange={(event) =>
                                props.setLabel(event.currentTarget.value)
                            }>
                            <option value="">All labels</option>
                            <For each={props.issues.facets.labels}>
                                {(item) => <option value={item}>{item}</option>}
                            </For>
                        </select>
                    </Show>
                </Show>
                <p class="hint m-0 ml-auto">{props.entries.length} shown</p>
            </section>
            <div
                class="@container max-w-[1500px] m-[0_auto]"
                aria-busy={props.pending ? "true" : "false"}>
                <Show
                    when={props.entries.length}
                    fallback={
                        <section class="empty max-w-[48ch] m-[6rem_auto] p-[0_2rem]">
                            <h2 class="m-0">
                                {props.notes.workspace.exists
                                    ? "Nothing found"
                                    : "No notes folder yet"}
                            </h2>
                            <p class="m-[0.75rem_0_0]">
                                {props.notes.workspace.exists
                                    ? props.shown === "vr"
                                        ? "No VR notes match these filters. Use Sync VR to notes on a task to add its visual report."
                                        : "Nothing matches these filters. Notes are Markdown files in the shared folder, and issues are provider JSON files beside them."
                                    : "Create the notes folder to keep research, decisions and evidence beside the work."}
                            </p>
                        </section>
                    }>
                    <div class="grid grid-flow-row-dense auto-rows-[22rem] grid-cols-[repeat(auto-fill,_minmax(18rem,_1fr))] gap-4">
                        <For each={props.entries} keyed={(entry) => entry.key}>
                            {(entry) => (
                                <LibraryCard
                                    entry={entry()}
                                    expanded={props.expanded.has(entry().key)}
                                    toggle={() => props.toggle(entry().key)}
                                    busy={props.opening(entry())}
                                    open={() => props.open(entry())}
                                    add={(kind) => props.add(entry(), kind)}
                                />
                            )}
                        </For>
                    </div>
                </Show>
            </div>
            <div class="max-w-[1500px] m-[1.5rem_auto_0]">
                <NotesStatus
                    workspace={props.notes.workspace}
                    busy={props.busy}
                    initialising={props.initialising}
                    initialise={props.initialise}
                />
            </div>
        </>
    )
}
