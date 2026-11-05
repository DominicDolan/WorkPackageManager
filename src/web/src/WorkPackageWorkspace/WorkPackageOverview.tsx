import {
    WORK_PACKAGE_RUN_STATUS_LABELS,
    nextWorkableTask,
    type WorkPackageDetail,
} from "@shared/types"
import { For, Show } from "solid-js"
import { api } from "../api"
import { InfoCard } from "../components/InfoCard"
import { TaskRow } from "./TaskRow"

export function WorkPackageOverview(props: {
    workPackage: WorkPackageDetail
    openTask: (ref: string) => void
    busy: string
    mutate: (label: string, action: () => Promise<unknown>) => Promise<void>
}) {
    const ready = () =>
        props.workPackage.tasks.filter((task) => task.status === "dev_complete")
            .length
    const closeable = () =>
        props.workPackage.tasks.filter(
            (task) =>
                task.status === "dev_complete" || task.status === "verified",
        ).length
    return (
        <div class="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
            <section>
                <div class="mb-4 flex items-center justify-between">
                    <h2 class="title">Tasks</h2>
                    <span class="description">
                        {props.workPackage.openCount} open ·{" "}
                        {props.workPackage.taskCount} total
                    </span>
                </div>
                <section class="collection">
                    <For
                        each={props.workPackage.tasks}
                        fallback={
                            <p class="p-10 text-center text-sm text-slate-400">
                                This work package has no tasks yet.
                            </p>
                        }>
                        {(task, index) => (
                            <TaskRow
                                task={task}
                                index={index()}
                                known={props.workPackage.tasks}
                                onClick={() => props.openTask(task.ref)}
                            />
                        )}
                    </For>
                </section>
                <Show when={props.workPackage.outsideBlockers.length}>
                    <p class="mt-4 p-4 text-sm notice warning">
                        This work package is waiting on{" "}
                        {props.workPackage.outsideBlockers
                            .map((task) => task.ref)
                            .join(", ")}{" "}
                        from outside the work package.
                    </p>
                </Show>
            </section>
            <aside class="space-y-5">
                <InfoCard title="Next up">
                    <Show
                        when={nextWorkableTask(props.workPackage)}
                        fallback={
                            <p class="description">
                                Nothing is currently ready to start.
                            </p>
                        }>
                        {(task) => (
                            <button
                                class="w-full text-left"
                                onClick={() => props.openTask(task().ref)}>
                                <span class="font-mono caption muted">
                                    {task().ref}
                                </span>
                                <strong class="mt-1 block text-sm">
                                    {task().title}
                                </strong>
                            </button>
                        )}
                    </Show>
                </InfoCard>
                <Show when={props.workPackage.run}>
                    {(run) => (
                        <InfoCard title="Latest work package run">
                            <div class="flex items-center justify-between">
                                <span class="text-sm font-medium">
                                    {
                                        WORK_PACKAGE_RUN_STATUS_LABELS[
                                            run().status
                                        ]
                                    }
                                </span>
                                <span class="caption muted">
                                    {run().worked.length} finished
                                </span>
                            </div>
                            <Show when={run().stopReason}>
                                <p class="mt-2 caption muted">
                                    {run().stopReason}
                                </p>
                            </Show>
                        </InfoCard>
                    )}
                </Show>
                <InfoCard title="Sign off">
                    <p class="mb-3 caption muted">
                        Apply review decisions to every eligible task in this
                        work package.
                    </p>
                    <div class="grid gap-2">
                        <button
                            aria-busy={
                                props.busy === "verify" ? "true" : "false"
                            }
                            class="outlined"
                            disabled={!ready() || !!props.busy}
                            onClick={() =>
                                props.mutate("verify", () =>
                                    api.advanceWorkPackage(
                                        props.workPackage.ref,
                                        "verified",
                                    ),
                                )
                            }>
                            Verify all ({ready()})
                        </button>
                        <button
                            aria-busy={
                                props.busy === "close" ? "true" : "false"
                            }
                            class="primary"
                            disabled={!closeable() || !!props.busy}
                            onClick={() =>
                                confirm(
                                    "Verify and close every eligible task in this work package?",
                                ) &&
                                props.mutate("close", () =>
                                    api.advanceWorkPackage(
                                        props.workPackage.ref,
                                        "closed",
                                    ),
                                )
                            }>
                            Verify and close ({closeable()})
                        </button>
                    </div>
                </InfoCard>
            </aside>
        </div>
    )
}
