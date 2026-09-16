import {
    For,
    Loading,
    Show,
    createEffect,
    createMemo,
    createSignal,
    refresh,
} from "solid-js"
import {
    ISSUE_SOURCE_LABELS,
    type IssueDetail,
    type IssueState,
    type IssueSummary,
} from "@shared/types"
import { api } from "../api"
import { PageSkeleton } from "../components/PageSkeleton"
import { ProductRail } from "../components/ProductRail"
import { BackIcon } from "../components/icons"
import type { MainView } from "../types/navigation"
import layoutStyles from "../components/LibraryLayout.module.css"
import styles from "./IssuesWorkspace.module.css"

export function IssuesWorkspace(props: {
    select: (view: MainView) => void
    revision: number
}) {
    const [query, setQuery] = createSignal("")
    const [state, setState] = createSignal<IssueState | "all">("all")
    const [source, setSource] = createSignal("")
    const [label, setLabel] = createSignal("")
    const [selectedId, setSelectedId] = createSignal("")
    const [busy, setBusy] = createSignal(false)
    const [error, setError] = createSignal("")
    const listing = createMemo(() =>
        api.listIssues({
            q: query() || undefined,
            state: state(),
            source: source() || undefined,
            label: label() || undefined,
        }),
    )
    const selected = createMemo(async (): Promise<IssueDetail | null> =>
        selectedId() ? api.getIssue(selectedId()) : null,
    )
    createEffect(
        () => props.revision,
        () => {
            refresh(listing)
            refresh(selected)
        },
    )
    const choose = (id: string) => {
        setSelectedId(id)
        refresh(selected)
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
            <ProductRail active="issues" select={props.select} />
            <Loading fallback={<PageSkeleton />}>
                <Show when={listing()} keyed>
                    {(data) => (
                        <section class="library-surface min-w-0 p-[2.2rem_clamp(1.3rem,_3.5vw,_4.5rem)_4rem] max-[820px]:p-[1.25rem] max-[820px]:overflow-hidden">
                            <header class="library-header flex max-w-[1500px] items-start justify-between gap-[2rem] m-[0_auto_1.5rem] p-[1.5rem_clamp(1.25rem,_3vw,_3rem)_1.7rem] [&_h1]:m-[0.45rem_0_0] [&_p:last-child]:max-w-[62ch] [&_p:last-child]:m-[0.8rem_0_0] max-[560px]:block max-[560px]:p-[1.25rem]">
                                <div>
                                    <p class="eyebrow m-0">Imported context</p>
                                    <h1>Issues</h1>
                                    <p>
                                        Review provider records from the notes
                                        folder. This view never writes back to
                                        the tracker.
                                    </p>
                                </div>
                                <div class="library-header-actions flex flex-wrap items-center justify-end gap-[0.5rem] max-[560px]:mt-[1.25rem] max-[560px]:justify-start">
                                    <Show
                                        when={
                                            data.notes.exists &&
                                            data.notes.git.repo
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
                                                !data.notes.git.upstream
                                            }
                                            title={
                                                data.notes.git.upstream ??
                                                "No upstream configured for this repository."
                                            }
                                            onClick={push}
                                        >
                                            {busy() ? "Pushing…" : "Push"}
                                        </button>
                                    </Show>
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
                                        <span>Find an issue</span>
                                        <input
                                            value={query()}
                                            onInput={(event) =>
                                                setQuery(
                                                    event.currentTarget.value,
                                                )
                                            }
                                            placeholder="Search issues"
                                            type="search"
                                        />
                                    </label>
                                    <div class="library-filters [&_select]:p-[0.58rem_0.65rem] grid gap-[0.5rem] p-[0.75rem_1rem]">
                                        <select
                                            value={state()}
                                            onChange={(event) =>
                                                setState(
                                                    event.currentTarget
                                                        .value as
                                                        IssueState | "all",
                                                )
                                            }
                                        >
                                            <option value="all">
                                                All states
                                            </option>
                                            <option value="open">Open</option>
                                            <option value="closed">
                                                Closed
                                            </option>
                                        </select>
                                        <Show
                                            when={
                                                data.facets.sources.length > 1
                                            }
                                        >
                                            <select
                                                value={source()}
                                                onChange={(event) =>
                                                    setSource(
                                                        event.currentTarget
                                                            .value,
                                                    )
                                                }
                                            >
                                                <option value="">
                                                    All sources
                                                </option>
                                                <For each={data.facets.sources}>
                                                    {(item) => (
                                                        <option
                                                            value={item.source}
                                                        >
                                                            {ISSUE_SOURCE_LABELS[
                                                                item.source
                                                            ] ??
                                                                item.source}{" "}
                                                            ({item.count})
                                                        </option>
                                                    )}
                                                </For>
                                            </select>
                                        </Show>
                                        <Show when={data.facets.labels.length}>
                                            <select
                                                value={label()}
                                                onChange={(event) =>
                                                    setLabel(
                                                        event.currentTarget
                                                            .value,
                                                    )
                                                }
                                            >
                                                <option value="">
                                                    All labels
                                                </option>
                                                <For each={data.facets.labels}>
                                                    {(item) => (
                                                        <option value={item}>
                                                            {item}
                                                        </option>
                                                    )}
                                                </For>
                                            </select>
                                        </Show>
                                    </div>
                                    <p class="issue-total m-[0.8rem_1rem]">
                                        {data.issues.length} of{" "}
                                        {data.facets.total} shown
                                    </p>
                                </aside>
                                <section class="issue-board min-w-0 p-[1.25rem]">
                                    <Loading
                                        fallback={<PageSkeleton compact />}
                                    >
                                        <Show
                                            when={selected()}
                                            keyed
                                            fallback={
                                                <For
                                                    each={data.issues}
                                                    fallback={
                                                        <div class="library-empty max-w-[48ch] m-[6rem_auto] p-[0_2rem] [&_h2]:m-0 [&_p]:m-[0.75rem_0_0]">
                                                            <h2>
                                                                No issues found
                                                            </h2>
                                                            <p>
                                                                Place provider
                                                                JSON files in
                                                                the notes folder
                                                                to see them
                                                                here.
                                                            </p>
                                                        </div>
                                                    }
                                                >
                                                    {(issue) => (
                                                        <IssueCard
                                                            issue={issue}
                                                            open={() =>
                                                                choose(issue.id)
                                                            }
                                                        />
                                                    )}
                                                </For>
                                            }
                                        >
                                            {(issue) => (
                                                <IssueDetailPane
                                                    issue={issue}
                                                    back={() =>
                                                        setSelectedId("")
                                                    }
                                                />
                                            )}
                                        </Show>
                                    </Loading>
                                </section>
                            </div>
                        </section>
                    )}
                </Show>
            </Loading>
        </main>
    )
}

function IssueCard(props: { issue: IssueSummary; open: () => void }) {
    return (
        <button
            class="issue-card block w-full mb-[0.8rem] p-[1rem] [&_h2]:m-[0.7rem_0_0] [&_p]:m-[0.5rem_0] [&_footer]:flex [&_footer]:flex-wrap [&_footer]:gap-[0.35rem] [&_footer_span]:p-[0.1rem_0.35rem]"
            onClick={props.open}
        >
            <div>
                <span class="source-badge inline-flex mr-[0.45rem] p-[0.15rem_0.42rem]">
                    {ISSUE_SOURCE_LABELS[props.issue.source] ??
                        props.issue.source}
                </span>
                <span class="issue-key">{props.issue.key}</span>
                <span
                    class={`issue-state issue-${props.issue.state} inline-flex mr-[0.45rem] p-[0.15rem_0.42rem]`}
                >
                    {props.issue.stateLabel}
                </span>
            </div>
            <h2>{props.issue.title}</h2>
            <p>
                {props.issue.excerpt ||
                    props.issue.container ||
                    "No summary provided."}
            </p>
            <footer>
                {props.issue.labels.slice(0, 3).map((label) => (
                    <span>{label.name}</span>
                ))}
            </footer>
        </button>
    )
}

function IssueDetailPane(props: { issue: IssueDetail; back: () => void }) {
    const [raw, setRaw] = createSignal(false)
    return (
        <article class="issue-detail-pane max-[560px]:[&_header]:block max-[560px]:[&_header_.button-primary]:mt-[1rem] max-w-[980px] p-[clamp(1.25rem,_3vw,_3rem)] [&_header]:flex [&_header]:items-start [&_header]:justify-between [&_header]:gap-[1rem] [&_header]:pb-[1.25rem] [&_h2]:max-w-[25ch] [&_h2]:m-[0.4rem_0_0] max-w-[1100px] [&>.back-link]:mb-[1.4rem]">
            <button
                class="back-link inline-flex items-center gap-[0.35rem]"
                onClick={props.back}
            >
                <BackIcon />
                All issues
            </button>
            <header>
                <div>
                    <span class="source-badge inline-flex mr-[0.45rem] p-[0.15rem_0.42rem]">
                        {ISSUE_SOURCE_LABELS[props.issue.source] ??
                            props.issue.source}
                    </span>
                    <span class="issue-key">{props.issue.key}</span>
                    <h2>{props.issue.title}</h2>
                </div>
                <Show when={props.issue.url}>
                    {(url) => (
                        <a
                            class="button-primary inline-flex min-h-[2.5rem] items-center justify-center gap-[0.45rem] p-[0.5rem_0.9rem]"
                            href={url()}
                            target="_blank"
                            rel="noreferrer"
                        >
                            Open source
                        </a>
                    )}
                </Show>
            </header>
            <dl class="issue-details grid grid-cols-[repeat(2,_minmax(0,_1fr))] gap-[1px] m-[1.5rem_0] [&>div]:p-[0.8rem] [&_dd]:m-[0.25rem_0_0] max-[560px]:grid-cols-[1fr]">
                <div>
                    <dt>State</dt>
                    <dd>{props.issue.stateLabel}</dd>
                </div>
                <div>
                    <dt>Assigned</dt>
                    <dd>
                        {props.issue.assignees
                            .map((person) => person.name)
                            .join(", ") || "Unassigned"}
                    </dd>
                </div>
                <div>
                    <dt>Updated</dt>
                    <dd>
                        {props.issue.updatedAt
                            ? new Date(
                                  props.issue.updatedAt,
                              ).toLocaleDateString()
                            : "—"}
                    </dd>
                </div>
                <div>
                    <dt>Comments</dt>
                    <dd>{props.issue.commentCount ?? "—"}</dd>
                </div>
            </dl>
            <section class="issue-body m-[1.5rem_0] [&_pre]:overflow-auto [&_pre]:p-[1rem]">
                <h3>Description</h3>
                <pre>{props.issue.body || "No description."}</pre>
            </section>
            <button
                class="button inline-flex min-h-[2.5rem] items-center justify-center gap-[0.45rem] p-[0.5rem_0.9rem]"
                onClick={() => setRaw(!raw())}
            >
                {raw() ? "Hide raw JSON" : "Show raw JSON"}
            </button>
            <Show when={raw()}>
                <pre class="raw-json overflow-auto p-[1rem] mt-[1rem] max-h-[28rem]">
                    {JSON.stringify(props.issue.raw, null, 2)}
                </pre>
            </Show>
        </article>
    )
}
