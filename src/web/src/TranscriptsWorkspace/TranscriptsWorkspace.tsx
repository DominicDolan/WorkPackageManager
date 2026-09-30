import { createQuery } from "../hooks/createQuery"
import type { TranscriptLink } from "@shared/types"
import {
    For,
    Loading,
    Show,
    createEffect,
    createMemo,
    createSignal,
    refresh,
} from "solid-js"
import { api } from "../api"
import { ProductRail } from "../components/ProductRail"
import { PageSkeleton } from "../components/PageSkeleton"
import type { MainView } from "../types/navigation"
import type { WorkspaceSnapshot } from "../types/workspace"
import styles from "./TranscriptsWorkspace.module.css"

export function TranscriptsWorkspace(props: {
    select: (view: MainView) => void
    snapshot: WorkspaceSnapshot
    initialPath: string
    revision: number
}) {
    const [selectedPath, setSelectedPath] = createSignal(props.initialPath)
    const [search, setSearch] = createSignal("")
    const [kind, setKind] =
        createSignal<TranscriptLink["kind"]>("investigation")
    const [ref, setRef] = createSignal("")
    const [busy, setBusy] = createSignal(false)
    const [error, setError] = createSignal("")
    const transcripts = createQuery(api.listTranscripts)
    const transcriptList = () => transcripts.value ?? []
    const selected = createQuery(async () =>
        selectedPath() ? api.getTranscript(selectedPath()) : null,
    )
    const targets = createMemo(() =>
        kind() === "task"
            ? props.snapshot.tasks.map((task) => ({
                  ref: task.ref,
                  title: task.title,
              }))
            : props.snapshot.investigations.map((investigation) => ({
                  ref: investigation.ref,
                  title: investigation.title,
              })),
    )
    const visible = createMemo(() => {
        const term = search().trim().toLowerCase()
        return transcriptList().filter(
            (item) =>
                !term ||
                [item.title, item.date, item.excerpt, item.path].some((value) =>
                    value.toLowerCase().includes(term),
                ),
        )
    })
    createEffect(transcriptList, (items) => {
        if (!selectedPath() && items.length) setSelectedPath(items[0]!.path)
    })
    createEffect(
        () => props.initialPath,
        (path) => {
            if (path) setSelectedPath(path)
        },
    )
    createEffect(
        () => props.revision,
        () => {
            refresh(transcripts)
            refresh(selected)
        },
    )

    const open = (path: string) => {
        setSelectedPath(path)
        setError("")
        history.replaceState(
            null,
            "",
            `/transcripts?transcript=${encodeURIComponent(path)}`,
        )
    }
    const changeLink = async (link: TranscriptLink, attach: boolean) => {
        if (busy() || !selectedPath()) return
        setBusy(true)
        setError("")
        try {
            if (attach) await api.addTranscriptLink(selectedPath(), link)
            else await api.removeTranscriptLink(selectedPath(), link)
            await Promise.all([refresh(selected), refresh(transcripts)])
            if (attach) setRef("")
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught))
        } finally {
            setBusy(false)
        }
    }

    return (
        <main class="app-shell min-h-screen grid grid-cols-[220px_minmax(0,_1fr)] max-[820px]:block">
            <ProductRail active="transcripts" select={props.select} />
            <section class={styles.surface}>
                <header class={styles.header}>
                    <p class="eyebrow m-0">Reference workspace</p>
                    <h1>Meeting transcripts</h1>
                    <p>
                        Synced transcript files from the notes folder. Attach a
                        conversation to the work it informs.
                    </p>
                </header>
                <Loading fallback={<PageSkeleton />}>
                    <div class={styles.layout}>
                        <aside class={styles.listPane} aria-label="Transcripts">
                            <label class="field">
                                <span>Search transcripts</span>
                                <input
                                    type="search"
                                    value={search()}
                                    onInput={(event) =>
                                        setSearch(event.currentTarget.value)
                                    }
                                    placeholder="Title, date, or text"
                                />
                            </label>
                            <p class={styles.count}>
                                {visible().length} transcript
                                {visible().length === 1 ? "" : "s"}
                            </p>
                            <Show
                                when={transcriptList().length}
                                fallback={
                                    <p class={styles.empty}>
                                        No transcript JSON files were found in
                                        the notes folder.
                                    </p>
                                }>
                                <For each={visible()}>
                                    {(item) => (
                                        <button
                                            class={styles.listItem}
                                            aria-current={
                                                selectedPath() === item.path
                                                    ? "true"
                                                    : undefined
                                            }
                                            onClick={() => open(item.path)}>
                                            <time>
                                                {item.date || "Date unknown"}
                                            </time>
                                            <strong>{item.title}</strong>
                                            <span>
                                                {item.excerpt ||
                                                    "No transcript text"}
                                            </span>
                                            <small>
                                                {item.links.length} attachment
                                                {item.links.length === 1
                                                    ? ""
                                                    : "s"}
                                            </small>
                                        </button>
                                    )}
                                </For>
                                <Show when={!visible().length}>
                                    <p class={styles.empty}>
                                        No matching transcripts.
                                    </p>
                                </Show>
                            </Show>
                        </aside>
                        <article class={styles.detail}>
                            <Loading fallback={<PageSkeleton compact />}>
                                <Show
                                    when={selected.value}
                                    fallback={
                                        <p class={styles.empty}>
                                            Select a transcript to read it.
                                        </p>
                                    }>
                                    {(item) => (
                                        <>
                                            <div class={styles.detailHeader}>
                                                <p class="eyebrow m-0">
                                                    {item().source} ·{" "}
                                                    {item().date ||
                                                        "Date unknown"}
                                                </p>
                                                <h2>{item().title}</h2>
                                                <p class={styles.path}>
                                                    {item().path}
                                                </p>
                                            </div>
                                            <section class={styles.links}>
                                                <h3>Attached to</h3>
                                                <Show
                                                    when={item().links.length}
                                                    fallback={
                                                        <p class={styles.muted}>
                                                            No tasks or
                                                            investigations
                                                            attached yet.
                                                        </p>
                                                    }>
                                                    <ul>
                                                        <For
                                                            each={item().links}>
                                                            {(link) => (
                                                                <li>
                                                                    <span>
                                                                        {link.kind ===
                                                                        "task"
                                                                            ? "Task"
                                                                            : "Investigation"}{" "}
                                                                        {
                                                                            link.ref
                                                                        }
                                                                    </span>
                                                                    <button
                                                                        class="outlined"
                                                                        disabled={busy()}
                                                                        onClick={() =>
                                                                            changeLink(
                                                                                link,
                                                                                false,
                                                                            )
                                                                        }
                                                                        aria-label={`Remove ${link.kind} ${link.ref}`}>
                                                                        Remove
                                                                    </button>
                                                                </li>
                                                            )}
                                                        </For>
                                                    </ul>
                                                </Show>
                                                <div class={styles.attachForm}>
                                                    <label class="field">
                                                        <span>Type</span>
                                                        <select
                                                            value={kind()}
                                                            onChange={(
                                                                event,
                                                            ) => {
                                                                setKind(
                                                                    event
                                                                        .currentTarget
                                                                        .value as TranscriptLink["kind"],
                                                                )
                                                                setRef("")
                                                            }}>
                                                            <option value="investigation">
                                                                Investigation
                                                            </option>
                                                            <option value="task">
                                                                Task
                                                            </option>
                                                        </select>
                                                    </label>
                                                    <label class="field">
                                                        <span>Work item</span>
                                                        <select
                                                            value={ref()}
                                                            onChange={(event) =>
                                                                setRef(
                                                                    event
                                                                        .currentTarget
                                                                        .value,
                                                                )
                                                            }>
                                                            <option value="">
                                                                Choose{" "}
                                                                {kind() ===
                                                                "task"
                                                                    ? "a task"
                                                                    : "an investigation"}
                                                            </option>
                                                            <For
                                                                each={targets()}>
                                                                {(target) => (
                                                                    <option
                                                                        value={
                                                                            target.ref
                                                                        }>
                                                                        {
                                                                            target.ref
                                                                        }{" "}
                                                                        ·{" "}
                                                                        {
                                                                            target.title
                                                                        }
                                                                    </option>
                                                                )}
                                                            </For>
                                                        </select>
                                                    </label>
                                                    <button
                                                        class="primary"
                                                        disabled={
                                                            busy() || !ref()
                                                        }
                                                        onClick={() =>
                                                            changeLink(
                                                                {
                                                                    kind: kind(),
                                                                    ref: ref(),
                                                                },
                                                                true,
                                                            )
                                                        }>
                                                        Attach
                                                    </button>
                                                </div>
                                                <Show when={error()}>
                                                    <p class="notice error">
                                                        {error()}
                                                    </p>
                                                </Show>
                                            </section>
                                            <section class={styles.content}>
                                                <h3>Transcript</h3>
                                                <div>{item().content}</div>
                                            </section>
                                        </>
                                    )}
                                </Show>
                            </Loading>
                        </article>
                    </div>
                </Loading>
            </section>
        </main>
    )
}
