import { MODEL_TIER_LABELS, type Task } from "@work-task-manager/shared"
import { For, Show } from "solid-js"
import { StatusBadge } from "../components/StatusBadge"

export function TaskRow(props: {
    task: Task
    index: number
    /** The tasks listed alongside this one, used to tell which of its blockers
     *  are done. Blockers outside this list are shown without a state. */
    known: Task[]
    onClick: () => void
}) {
    const byRef = () =>
        new Map(props.known.map((task) => [task.ref.toLowerCase(), task]))
    /** Unfinished blockers, as the server worked them out across the whole
     *  workspace; `known` only supplies their titles. */
    const unmet = () =>
        props.task.blockedBy.map(
            (ref) =>
                byRef().get(ref.toLowerCase()) ?? ({ ref, title: ref } as Task),
        )
    return (
        <button
            class="card-item row flex w-full items-start gap-4 px-5 py-4 text-left"
            onClick={props.onClick}>
            <span class="mt-1 w-5 text-right font-mono text-xs text-slate-300">
                {props.index + 1}
            </span>
            <div class="min-w-0 flex-1">
                <div class="flex flex-wrap items-center gap-2">
                    <span class="font-mono text-xs font-semibold text-slate-400">
                        {props.task.ref}
                    </span>
                    <StatusBadge status={props.task.status} />
                    <Show when={props.task.gitError}>
                        <span
                            class="badge inline-flex items-center p-[0.16rem_0.48rem] text-red-700"
                            title={props.task.gitError?.message}
                            data-testid="task-row-git-error">
                            ⚠ Git failed
                        </span>
                    </Show>
                    <Show when={unmet().length}>
                        <span
                            class="badge warning inline-flex items-center p-[0.16rem_0.48rem]"
                            title={`Waiting on ${unmet()
                                .map((task) => task.ref)
                                .join(", ")}`}
                            data-testid="task-row-blocked">
                            Blocked
                        </span>
                    </Show>
                </div>
                <p class="mt-1.5 truncate text-sm font-medium text-slate-800">
                    {props.task.title}
                </p>
                <Show
                    when={
                        props.task.dependsOn.length || props.task.blocks.length
                    }>
                    <div
                        class="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 caption muted"
                        data-testid="task-row-dependencies">
                        <Show when={props.task.dependsOn.length}>
                            <span class="inline-flex flex-wrap items-center gap-1.5">
                                Depends on
                                <For each={props.task.dependsOn}>
                                    {(ref) => {
                                        const blocker = () =>
                                            byRef().get(ref.toLowerCase())
                                        const done = () =>
                                            !props.task.blockedBy.some(
                                                (one) =>
                                                    one.toLowerCase() ===
                                                    ref.toLowerCase(),
                                            )
                                        return (
                                            <span
                                                class={`badge inline-flex items-center p-[0.1rem_0.4rem] font-mono ${done() ? "success" : "warning"}`}
                                                title={`${blocker()?.title ?? ref} — ${done() ? "done" : "not done yet"}`}>
                                                {done() ? "✓ " : ""}
                                                {ref}
                                            </span>
                                        )
                                    }}
                                </For>
                            </span>
                        </Show>
                        <Show when={props.task.blocks.length}>
                            <span>
                                Blocks{" "}
                                <span class="font-mono">
                                    {props.task.blocks.join(", ")}
                                </span>
                            </span>
                        </Show>
                    </div>
                </Show>
            </div>
            <div class="mt-1 flex shrink-0 items-center gap-2">
                <span class="text-xs capitalize text-slate-400">
                    {props.task.priority}
                </span>
                <span
                    class={`badge inline-flex items-center p-[0.16rem_0.48rem] ${props.task.recommendedTier === "frontier" ? "accent" : ""}`}
                    title="Recommended model tier">
                    {props.task.recommendedTier
                        ? MODEL_TIER_LABELS[props.task.recommendedTier]
                        : "No tier"}
                </span>
            </div>
        </button>
    )
}
