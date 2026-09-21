import {
    ISSUE_SOURCE_LABELS,
    type WorkPackageDetail,
    type WorkPackageReference,
} from "@shared/types"
import {
    action,
    createMemo,
    createOptimistic,
    createSignal,
    For,
    Loading,
    Show,
} from "solid-js"
import { api, noteAssetUrl } from "../api"
import { useError } from "../hooks/useError"
import { renderRichBody } from "../IssuesWorkspace/issueBody"

/**
 * The work package's fixed Notes tab: the notes and issues attached to it, as
 * one grid of cards. Nothing is grouped by kind. A card's size follows how much
 * there is to read, and the dense grid lets small cards fill the gaps the large
 * ones leave.
 */
export function NotesPanel(props: {
    workPackage: WorkPackageDetail
    openNote: (path: string) => void
    openIssue: (id: string) => void
    changed: () => void
}) {
    const [busy, setBusy] = createOptimistic("")
    const { capture, clear, Banner } = useError()
    const refOf = (reference: WorkPackageReference) =>
        reference.kind === "note"
            ? `note:${reference.note.path}`
            : `issue:${reference.issue.id}`

    const run = action(function* (
        key: string,
        request: () => Promise<unknown>,
    ) {
        if (busy()) return

        setBusy(key)
        clear()
        try {
            yield request()
            props.changed()
        } catch (caught) {
            capture(caught)
        }
    })
    const attach = (key: string) => {
        const [kind, ...rest] = key.split(":")
        const id = rest.join(":")
        return run(key, () =>
            kind === "note"
                ? api.attachWorkPackageNote(props.workPackage.ref, id)
                : api.attachWorkPackageIssue(props.workPackage.ref, id),
        )
    }
    const detach = (reference: WorkPackageReference) =>
        run(refOf(reference), () =>
            reference.kind === "note"
                ? api.detachWorkPackageNote(
                      props.workPackage.ref,
                      reference.note.path,
                  )
                : api.detachWorkPackageIssue(
                      props.workPackage.ref,
                      reference.issue.id,
                  ),
        )
    const open = (reference: WorkPackageReference) =>
        reference.kind === "note"
            ? props.openNote(reference.note.path)
            : props.openIssue(reference.issue.id)

    return (
        <section class="grid gap-5">
            <div class="flex flex-wrap items-center justify-between gap-3">
                <div>
                    <h2 class="title">Notes</h2>
                    <p class="description m-[0.25rem_0_0]">
                        Notes and issues from the notes folder that this work
                        package draws on.
                    </p>
                </div>
                <Loading
                    fallback={
                        <span class="caption muted">Loading notes…</span>
                    }>
                    <AttachPicker
                        attached={
                            new Set(props.workPackage.references.map(refOf))
                        }
                        busy={busy()}
                        attach={attach}
                    />
                </Loading>
            </div>
            <Banner />
            <Show
                when={props.workPackage.references.length}
                fallback={
                    <p class="tonal p-10 text-center description">
                        Nothing attached yet. Choose a note or an issue above.
                    </p>
                }>
                <div class="grid grid-flow-row-dense auto-rows-[10.5rem] grid-cols-[repeat(auto-fill,_minmax(15rem,_1fr))] gap-4">
                    <For each={props.workPackage.references}>
                        {(reference) => (
                            <ReferenceCard
                                reference={reference}
                                busy={busy() === refOf(reference)}
                                disabled={!!busy()}
                                open={() => open(reference)}
                                detach={() => detach(reference)}
                            />
                        )}
                    </For>
                </div>
            </Show>
        </section>
    )
}

/** One picker for both kinds, grouped only so the list is scannable. */
function AttachPicker(props: {
    attached: Set<string>
    busy: string
    attach: (key: string) => void
}) {
    const notes = createMemo(() => api.listNotes())
    const issues = createMemo(() => api.listIssues({ state: "all" }))
    const [selected, setSelected] = createSignal("")
    const availableNotes = () =>
        notes().notes.filter((note) => !props.attached.has(`note:${note.path}`))
    const availableIssues = () =>
        issues().issues.filter(
            (issue) => !props.attached.has(`issue:${issue.id}`),
        )
    const empty = () => !availableNotes().length && !availableIssues().length

    return (
        <Show
            when={notes().workspace.exists}
            fallback={
                <span class="caption muted">
                    Create the notes folder before attaching anything.
                </span>
            }>
            <div class="flex w-full max-w-[32rem] gap-2">
                <select
                    aria-label="Note or issue to attach"
                    class="min-w-0 flex-1 p-[0.6rem_0.7rem]"
                    value={selected()}
                    disabled={empty() || !!props.busy}
                    onChange={(event) =>
                        setSelected(event.currentTarget.value)
                    }>
                    <option value="">
                        {empty()
                            ? "Everything is attached"
                            : "Choose a note or issue…"}
                    </option>
                    <Show when={availableNotes().length}>
                        <optgroup label="Notes">
                            <For each={availableNotes()}>
                                {(note) => (
                                    <option value={`note:${note.path}`}>
                                        {note.title}
                                    </option>
                                )}
                            </For>
                        </optgroup>
                    </Show>
                    <Show when={availableIssues().length}>
                        <optgroup label="Issues">
                            <For each={availableIssues()}>
                                {(issue) => (
                                    <option value={`issue:${issue.id}`}>
                                        {issue.key} {issue.title}
                                    </option>
                                )}
                            </For>
                        </optgroup>
                    </Show>
                </select>
                <button
                    class="outlined"
                    aria-busy={
                        props.busy && props.busy === selected()
                            ? "true"
                            : "false"
                    }
                    disabled={!selected() || !!props.busy}
                    onClick={() => {
                        props.attach(selected())
                        setSelected("")
                    }}>
                    Attach
                </button>
            </div>
        </Show>
    )
}

/**
 * Column and row spans by how much readable text there is. Two columns at most,
 * so a large card never leaves the grid with a single column beside it, and
 * one column on a phone.
 */
function sizeClass(length: number): string {
    if (length < 350) return ""
    if (length < 1200) return "row-span-2"
    if (length < 3000) return "col-span-2 row-span-2 max-[640px]:col-span-1"
    return "col-span-2 row-span-3 max-[640px]:col-span-1"
}

function ReferenceCard(props: {
    reference: WorkPackageReference
    busy: boolean
    disabled: boolean
    open: () => void
    detach: () => void
}) {
    const title = () =>
        props.reference.kind === "note"
            ? props.reference.note.title
            : props.reference.issue.title
    const html = () => {
        const reference = props.reference
        return renderRichBody(
            reference.preview,
            reference.previewFormat,
            reference.kind === "note"
                ? {
                      resolveLink: (href) =>
                          noteAssetUrl(reference.note.path, href),
                  }
                : {},
        )
    }

    return (
        <article
            class={`summary flex min-w-0 flex-col overflow-hidden p-4 ${sizeClass(props.reference.length)}`}>
            <header class="flex items-start gap-2">
                <button
                    class="min-w-0 flex-1 text-left"
                    onClick={() => props.open()}>
                    <span class="flex flex-wrap items-center gap-[0.4rem] caption muted">
                        <Show
                            when={
                                props.reference.kind === "issue" &&
                                props.reference.issue
                            }
                            fallback={
                                <>
                                    <span class="badge p-[0.1rem_0.4rem]">
                                        Note
                                    </span>
                                    <Show
                                        when={
                                            props.reference.kind === "note" &&
                                            props.reference.note.folder
                                        }>
                                        {(folder) => (
                                            <span class="truncate">
                                                {folder()}
                                            </span>
                                        )}
                                    </Show>
                                </>
                            }>
                            {(issue) => (
                                <>
                                    <span class="badge info p-[0.1rem_0.4rem]">
                                        {ISSUE_SOURCE_LABELS[issue().source] ??
                                            issue().source}
                                    </span>
                                    <span class="font-mono">{issue().key}</span>
                                    <span
                                        class="badge success p-[0.1rem_0.4rem]"
                                        data-status={issue().state}>
                                        {issue().stateLabel}
                                    </span>
                                </>
                            )}
                        </Show>
                    </span>
                    <strong class="mt-1 block line-clamp-2 text-sm text-slate-800">
                        {title()}
                    </strong>
                </button>
                <button
                    class="outlined px-2 py-1 text-xs"
                    disabled={props.disabled}
                    aria-busy={props.busy ? "true" : "false"}
                    aria-label={`Detach ${title()}`}
                    title="Detach"
                    onClick={() => props.detach()}>
                    Detach
                </button>
            </header>
            <Show
                when={html()}
                fallback={<p class="mt-2 caption muted">No content.</p>}>
                {(content) => (
                    <div
                        class="prose mt-2 min-h-0 flex-1 cursor-pointer overflow-hidden text-[0.8rem] leading-[1.55] [mask-image:linear-gradient(to_bottom,black_70%,transparent)] [&_h1]:text-base [&_h2]:text-[0.95rem] [&_h3]:text-[0.85rem] [&_img]:max-w-full"
                        onClick={(event) => {
                            // A link inside the preview goes where it says.
                            if (!(event.target as Element).closest("a"))
                                props.open()
                        }}
                        innerHTML={content()}
                    />
                )}
            </Show>
        </article>
    )
}
