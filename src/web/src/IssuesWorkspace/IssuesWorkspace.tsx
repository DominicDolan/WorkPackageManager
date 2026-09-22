import { createQuery } from "../hooks/createQuery"
import {
    ISSUE_SOURCE_LABELS,
    type IssueDetail,
    type IssueState,
} from "@shared/types"
import {
    action,
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
import { PageSkeleton } from "../components/PageSkeleton"
import { ProductRail } from "../components/ProductRail"
import type { MainView } from "../types/navigation"
import { IssueCard } from "./IssueCard"
import { IssueDetailPane } from "./IssueDetailPane"

export function IssuesWorkspace(props: {
    select: (view: MainView) => void
    initialId?: string
    revision: number
}) {
    const [query, setQuery] = createSignal("")
    const [state, setState] = createSignal<IssueState | "all">("all")
    const [source, setSource] = createSignal("")
    const [label, setLabel] = createSignal("")
    const [selectedId, setSelectedId] = createSignal(props.initialId ?? "")
    const [busy, setBusy] = createOptimistic("")
    const { capture, clear, Banner } = useError()
    const listing = createQuery(() =>
        api.listIssues({
            q: query() || undefined,
            state: state(),
            source: source() || undefined,
            label: label() || undefined,
        }),
    )
    const selected = createQuery(async (): Promise<IssueDetail | null> =>
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
    const sync = action(async function* () {
        if (busy()) return

        setBusy("sync")
        clear()
        try {
            const pulled = await api.pullNotes()
            yield
            // Resolving it is offered from Notes, which owns the folder.
            if (pulled.conflict)
                throw new Error(
                    `Merging ${pulled.conflict.onto} into the notes repository conflicted, so nothing changed. Sync from Notes to resolve it with an agent.`,
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
            <ProductRail active="issues" select={props.select} />
            <Loading fallback={<PageSkeleton />}>
                <Show when={listing.value} keyed>
                    {(data) => (
                        <section class="library-surface min-w-0 p-[2.2rem_clamp(1.3rem,_3.5vw,_4.5rem)_4rem] max-[820px]:p-[1.25rem] max-[820px]:overflow-hidden">
                            <header class="library flex max-w-[1500px] items-start justify-between gap-[2rem] m-[0_auto_1.5rem] p-[1.5rem_clamp(1.25rem,_3vw,_3rem)_1.7rem] max-[560px]:block max-[560px]:p-[1.25rem]">
                                <div>
                                    <p class="eyebrow m-0">Imported context</p>
                                    <h1 class="m-[0.45rem_0_0]">Issues</h1>
                                    <p class="max-w-[62ch] m-[0.8rem_0_0]">
                                        Review provider records from the notes
                                        folder. This view never writes back to
                                        the tracker.
                                    </p>
                                </div>
                                <div class="flex flex-wrap items-center justify-end gap-[0.5rem] max-[560px]:mt-[1.25rem] max-[560px]:justify-start">
                                    <Show
                                        when={
                                            data.notes.exists &&
                                            data.notes.git.repo
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
                                                !data.notes.git.upstream
                                            }
                                            title={
                                                data.notes.git.upstream ??
                                                "No upstream configured for this repository."
                                            }
                                            onClick={push}>
                                            Push
                                        </button>
                                    </Show>
                                </div>
                            </header>
                            <Banner />
                            <section class="library grid grid-cols-[minmax(260px,_310px)_minmax(0,_1fr)] max-w-[1500px] min-h-[620px] m-[0_auto] max-[820px]:grid-cols-[1fr]">
                                <aside class="library flex min-w-0 flex-col">
                                    <label class="search grid gap-[0.45rem] p-[1rem]">
                                        <span>Find an issue</span>
                                        <input
                                            class="p-[0.58rem_0.65rem]"
                                            value={latest(query)}
                                            onInput={(event) =>
                                                setQuery(
                                                    event.currentTarget.value,
                                                )
                                            }
                                            placeholder="Search issues"
                                            type="search"
                                        />
                                    </label>
                                    <div class="filters grid gap-[0.5rem] p-[0.75rem_1rem]">
                                        <select
                                            class="p-[0.58rem_0.65rem]"
                                            value={latest(state)}
                                            onChange={(event) =>
                                                setState(
                                                    event.currentTarget
                                                        .value as
                                                        IssueState | "all",
                                                )
                                            }>
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
                                            }>
                                            <select
                                                class="p-[0.58rem_0.65rem]"
                                                value={latest(source)}
                                                onChange={(event) =>
                                                    setSource(
                                                        event.currentTarget
                                                            .value,
                                                    )
                                                }>
                                                <option value="">
                                                    All sources
                                                </option>
                                                <For each={data.facets.sources}>
                                                    {(item) => (
                                                        <option
                                                            value={item.source}>
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
                                                value={latest(label)}
                                                onChange={(event) =>
                                                    setLabel(
                                                        event.currentTarget
                                                            .value,
                                                    )
                                                }>
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
                                    <p class="hint m-[0.8rem_1rem]">
                                        {data.issues.length} of{" "}
                                        {data.facets.total} shown
                                    </p>
                                </aside>
                                <section class="detail min-w-0 p-[1.25rem]">
                                    <Loading
                                        fallback={<PageSkeleton compact />}>
                                        <div
                                            aria-busy={
                                                isPending(
                                                    () => listing.value,
                                                ) ||
                                                isPending(() => selected.value)
                                                    ? "true"
                                                    : "false"
                                            }>
                                            <Show
                                                when={selected.value}
                                                keyed
                                                fallback={
                                                    <For
                                                        each={data.issues}
                                                        fallback={
                                                            <section class="empty max-w-[48ch] m-[6rem_auto] p-[0_2rem]">
                                                                <h2 class="m-0">
                                                                    No issues
                                                                    found
                                                                </h2>
                                                                <p class="m-[0.75rem_0_0]">
                                                                    Place
                                                                    provider
                                                                    JSON files
                                                                    in the notes
                                                                    folder to
                                                                    see them
                                                                    here.
                                                                </p>
                                                            </section>
                                                        }>
                                                        {(issue) => (
                                                            <IssueCard
                                                                issue={issue}
                                                                busy={
                                                                    latest(
                                                                        selectedId,
                                                                    ) ===
                                                                        issue.id &&
                                                                    isPending(
                                                                        () =>
                                                                            selected.value,
                                                                    )
                                                                }
                                                                open={() =>
                                                                    choose(
                                                                        issue.id,
                                                                    )
                                                                }
                                                            />
                                                        )}
                                                    </For>
                                                }>
                                                {(issue) => (
                                                    <div
                                                        inert={isPending(
                                                            () =>
                                                                selected.value,
                                                        )}>
                                                        <IssueDetailPane
                                                            issue={issue}
                                                            back={() =>
                                                                setSelectedId(
                                                                    "",
                                                                )
                                                            }
                                                        />
                                                    </div>
                                                )}
                                            </Show>
                                        </div>
                                    </Loading>
                                </section>
                            </section>
                        </section>
                    )}
                </Show>
            </Loading>
        </main>
    )
}
