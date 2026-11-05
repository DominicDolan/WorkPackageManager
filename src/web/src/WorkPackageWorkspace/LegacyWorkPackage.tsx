import { type Task } from "@shared/types"
import { For } from "solid-js"
import { TaskRow } from "./TaskRow"

export function LegacyWorkPackage(props: {
    tasks: Task[]
    back: () => void
    openTask: (ref: string) => void
}) {
    return (
        <div class="mx-auto max-w-5xl px-5 py-8 sm:px-8">
            <button
                class="mb-5 text-sm font-medium text-slate-500"
                onClick={props.back}>
                ← All work packages
            </button>
            <div class="border border-amber-200 p-5 notice warning">
                <h1 class="text-2xl font-semibold">Unassigned</h1>
                <p class="mt-2 text-sm text-amber-800">
                    These are legacy records. They remain available, but new
                    tasks cannot be added here. Move each task into a real work
                    package when convenient.
                </p>
            </div>
            <article class="mt-6 overflow-hidden">
                <For each={props.tasks}>
                    {(task, index) => (
                        <TaskRow
                            task={task}
                            index={index()}
                            known={props.tasks}
                            onClick={() => props.openTask(task.ref)}
                        />
                    )}
                </For>
            </article>
        </div>
    )
}
