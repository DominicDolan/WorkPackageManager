import {
    ISSUE_SOURCE_LABELS,
    type IssueListItem,
    type NoteListItem,
} from "@work-task-manager/shared"
import { Show, createMemo } from "solid-js"
import { noteAssetUrl } from "../api"
import {
    AddToWorkPackageButtons,
    type WorkItemKind,
} from "../components/AddToWorkPackage"
import { CollapseIcon, ExpandIcon } from "../components/icons"
import { renderRichBody } from "../IssuesWorkspace/issueBody"

/** A note or an issue in the grid. `key` is stable across refreshes, so a card
 *  keeps its size and scroll position when the list is read again. */
export type LibraryEntry =
    | { kind: "note"; key: string; updatedAt: string; note: NoteListItem }
    | { kind: "issue"; key: string; updatedAt: string; issue: IssueListItem }

/**
 * One card in the Notes grid. The whole body is on the card and scrolls inside
 * it, so a note can be read without opening it; the title opens the editor or
 * the issue's detail. Expanding takes an extra row and column of the grid.
 */
export function LibraryCard(props: {
    entry: LibraryEntry
    expanded: boolean
    toggle: () => void
    open: () => void
    add: (kind: WorkItemKind) => void
    busy: boolean
}) {
    const title = () =>
        props.entry.kind === "note"
            ? props.entry.note.title
            : props.entry.issue.title
    const html = createMemo(() => {
        const entry = props.entry
        return entry.kind === "note"
            ? renderRichBody(entry.note.body, "markdown", {
                  resolveLink: (href) => noteAssetUrl(entry.note.path, href),
              })
            : renderRichBody(entry.issue.body, entry.issue.bodyFormat)
    })

    // Two columns only once the grid has two (18rem each, 1rem gap): spanning
    // more tracks than exist adds an implicit column that overflows the page.
    return (
        <article
            class={`flex min-w-0 flex-col overflow-hidden ${props.expanded ? "row-span-2 @min-[37rem]:col-span-2" : ""}`}
            aria-busy={props.busy ? "true" : "false"}>
            <header class="flex items-start gap-2 p-[0.85rem_0.85rem_0.7rem_1rem]">
                <button
                    class="min-w-0 flex-1 text-left"
                    title={`Open ${title()}`}
                    onClick={() => props.open()}>
                    <span class="flex flex-wrap items-center gap-[0.4rem] caption muted">
                        <Show
                            when={
                                props.entry.kind === "issue" &&
                                props.entry.issue
                            }
                            fallback={
                                <>
                                    <span class="badge p-[0.1rem_0.4rem]">
                                        Note
                                    </span>
                                    <Show
                                        when={
                                            props.entry.kind === "note" &&
                                            props.entry.note.folder
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
                    class="shrink-0 p-1 text-slate-500 hover:text-slate-800"
                    aria-pressed={props.expanded ? "true" : "false"}
                    aria-label={
                        props.expanded
                            ? `Shrink ${title()}`
                            : `Expand ${title()}`
                    }
                    title={props.expanded ? "Shrink" : "Expand"}
                    onClick={() => props.toggle()}>
                    <Show when={props.expanded} fallback={<ExpandIcon />}>
                        <CollapseIcon />
                    </Show>
                </button>
            </header>
            <Show
                when={html()}
                fallback={
                    <p class="min-h-0 flex-1 p-[0.85rem_1rem] caption muted">
                        No content.
                    </p>
                }>
                {(content) => (
                    <div
                        class="prose min-h-0 flex-1 overflow-auto p-[0.85rem_1rem] text-[0.8rem] leading-[1.55] [&_h1]:text-base [&_h2]:text-[0.95rem] [&_h3]:text-[0.85rem] [&_img]:max-w-full"
                        innerHTML={content()}
                    />
                )}
            </Show>
            <footer class="flex justify-end border-t border-[var(--line)] p-[0.65rem_0.85rem]">
                <AddToWorkPackageButtons add={props.add} />
            </footer>
        </article>
    )
}
