import { MODEL_TIER_LABELS, type Task } from "@shared/types"
import { Show } from "solid-js"
import { StatusBadge } from "../components/StatusBadge"

export function TaskRow(props: {
    task: Task
    index: number
    onClick: () => void
}) {
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
                </div>
                <p class="mt-1.5 truncate text-sm font-medium text-slate-800">
                    {props.task.title}
                </p>
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
