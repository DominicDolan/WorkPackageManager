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

export function TranscriptAttachments(props: {
    kind: TranscriptLink["kind"]
    ref: string
    revision: number
}) {
    const transcripts = createQuery(api.listTranscripts)
    const transcriptList = () => transcripts.value ?? []
    createEffect(
        () => props.revision,
        () => {
            refresh(transcripts)
        },
    )
    const [path, setPath] = createSignal("")
    const [busy, setBusy] = createSignal(false)
    const [error, setError] = createSignal("")
    const attached = createMemo(() =>
        transcriptList().filter((item) =>
            item.links.some(
                (link) => link.kind === props.kind && link.ref === props.ref,
            ),
        ),
    )
    const available = createMemo(() =>
        transcriptList().filter(
            (item) =>
                !item.links.some(
                    (link) =>
                        link.kind === props.kind && link.ref === props.ref,
                ),
        ),
    )
    const change = async (transcriptPath: string, attach: boolean) => {
        if (busy()) return
        setBusy(true)
        setError("")
        try {
            const link = { kind: props.kind, ref: props.ref }
            if (attach) await api.addTranscriptLink(transcriptPath, link)
            else await api.removeTranscriptLink(transcriptPath, link)
            await refresh(transcripts)
            setPath("")
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught))
        } finally {
            setBusy(false)
        }
    }
    return (
        <section class="mt-6 p-5 border border-slate-300 bg-slate-100">
            <h3 class="m-0 text-base font-semibold">Meeting transcripts</h3>
            <p class="mt-1 mb-4 text-sm text-slate-500">
                Conversations linked to this {props.kind}.
            </p>
            <Loading
                fallback={
                    <p class="text-sm text-slate-500">Loading transcripts…</p>
                }>
                <Show
                    when={attached().length}
                    fallback={
                        <p class="text-sm text-slate-500 mb-4">
                            No transcripts attached.
                        </p>
                    }>
                    <ul class="list-none m-0 mb-4 p-0 grid gap-2">
                        <For each={attached()}>
                            {(item) => (
                                <li class="flex flex-wrap items-center justify-between gap-2 border border-slate-300 p-3">
                                    <a
                                        class="text-sm text-blue-600 hover:underline"
                                        href={`/transcripts?transcript=${encodeURIComponent(item.path)}`}>
                                        {item.title}{" "}
                                        <span class="text-slate-500">
                                            · {item.date}
                                        </span>
                                    </a>
                                    <button
                                        class="outlined"
                                        disabled={busy()}
                                        onClick={() =>
                                            change(item.path, false)
                                        }>
                                        Remove
                                    </button>
                                </li>
                            )}
                        </For>
                    </ul>
                </Show>
                <div class="flex flex-wrap items-end gap-2">
                    <label class="field min-w-[220px] flex-1">
                        <span>Attach transcript</span>
                        <select
                            value={path()}
                            onChange={(event) =>
                                setPath(event.currentTarget.value)
                            }>
                            <option value="">Choose a transcript</option>
                            <For each={available()}>
                                {(item) => (
                                    <option value={item.path}>
                                        {item.date} · {item.title}
                                    </option>
                                )}
                            </For>
                        </select>
                    </label>
                    <button
                        class="primary"
                        disabled={busy() || !path()}
                        onClick={() => change(path(), true)}>
                        Attach
                    </button>
                </div>
                <Show when={!transcriptList().length}>
                    <p class="mt-3 text-sm text-slate-500">
                        Transcript JSON files in the notes folder will appear
                        here after sync.
                    </p>
                </Show>
                <Show when={error()}>
                    <p class="notice error mt-3">{error()}</p>
                </Show>
            </Loading>
        </section>
    )
}
