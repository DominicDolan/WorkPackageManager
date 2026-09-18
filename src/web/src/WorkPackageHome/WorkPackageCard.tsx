import type { Task, WorkPackageSummary } from "@shared/types"
import { For, Show } from "solid-js"

export function WorkPackageCard(props: {
    workPackage: WorkPackageSummary
    tasks: Task[]
    open: () => void
    legacy?: boolean
}) {
    const progress = () =>
        props.workPackage.taskCount
            ? Math.round(
                  (props.workPackage.devCompleteCount /
                      props.workPackage.taskCount) *
                      100,
              )
            : 0
    return (
        <button
            class="card-item row text-left relative grid w-full grid-cols-[6px_minmax(240px,_1.2fr)_minmax(220px,_1fr)_150px_38px] items-center gap-[clamp(1rem,_2vw,_2.5rem)] overflow-hidden focus-visible:z-[1] max-[1050px]:grid-cols-[6px_minmax(230px,_1.25fr)_minmax(180px,_1fr)_120px_30px] max-[1050px]:gap-[1.2rem] max-[820px]:w-full max-[820px]:min-w-0 max-[820px]:max-w-full max-[820px]:grid-cols-[6px_minmax(0,_1fr)_100px_28px] max-[560px]:grid-cols-[5px_minmax(0,_1fr)] max-[560px]:gap-[1rem]"
            onClick={props.open}>
            <span
                class="work-package-stripe self-stretch"
                style={{ background: props.workPackage.color }}
            />
            <div class="min-w-0 p-[1.55rem_0] max-[820px]:overflow-hidden max-[560px]:p-[1.2rem_0]">
                <span class="reference">
                    {props.legacy ? "Legacy work" : props.workPackage.ref}
                </span>
                <h3 class="m-[0.35rem_0_0]">{props.workPackage.name}</h3>
                <p class="line-clamp-2 max-w-[52ch] m-[0.45rem_0_0] overflow-hidden">
                    {props.workPackage.brief ||
                        "Add an investigation to define the outcome for this work package."}
                </p>
            </div>
            <div class="task-preview min-w-0 p-[1.25rem_0] max-[820px]:hidden">
                <For
                    each={props.tasks.slice(0, 3)}
                    fallback={
                        <p class="caption muted m-[0.5rem_0_0] m-[0.5rem_0_0_1.05rem] ml-0">
                            {props.workPackage.taskCount
                                ? "All tasks are closed."
                                : "No tasks yet. Open the work package to add the first one."}
                        </p>
                    }>
                    {(task) => (
                        <div class="task-preview-row flex min-w-0 items-center gap-[0.6rem] m-[0.45rem_0]">
                            <span
                                class="dot w-[0.45rem] h-[0.45rem] flex-none"
                                data-status={task.status}
                            />
                            <span class="overflow-hidden">{task.title}</span>
                        </div>
                    )}
                </For>
                <Show when={props.tasks.length > 3}>
                    <p class="caption muted m-[0.5rem_0_0_1.05rem]">
                        {props.tasks.length - 3} more tasks
                    </p>
                </Show>
            </div>
            <div class="work-package-progress p-[1.25rem_0] max-[560px]:hidden">
                <div class="progress-copy">
                    <strong>{props.workPackage.devCompleteCount}</strong>
                    <span> / {props.workPackage.taskCount}</span>
                </div>
                <div class="progress-track h-[3px] mt-[0.65rem] overflow-hidden">
                    <span
                        class="block h-full"
                        style={{
                            width: `${progress()}%`,
                            background: props.workPackage.color,
                        }}
                    />
                </div>
                <small class="block mt-[0.38rem]">
                    {progress()}% dev complete
                </small>
            </div>
            <span
                class="open-cue grid w-[2rem] h-[2rem] place-items-center max-[560px]:hidden"
                aria-hidden="true">
                <svg class="w-[1.15rem]" viewBox="0 0 24 24">
                    <path d="m9 5 7 7-7 7" />
                </svg>
            </span>
        </button>
    )
}
