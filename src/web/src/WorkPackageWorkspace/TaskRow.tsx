import { type Task } from "@shared/types"
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
                </div>
                <p class="mt-1.5 truncate text-sm font-medium text-slate-800">
                    {props.task.title}
                </p>
            </div>
            <span class="mt-2 text-xs capitalize text-slate-400">
                {props.task.priority}
            </span>
        </button>
    )
}
