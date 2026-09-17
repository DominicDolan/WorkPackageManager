import { workPackageQueueBlockers, type Task } from "@shared/types"
import {
    action,
    createOptimistic,
    For,
    Loading,
    Show,
    createEffect,
    createMemo,
    createSignal,
    refresh,
    isPending,
    latest,
} from "solid-js"
import { AgentLauncher } from "../AgentLauncher/AgentLauncher"
import { api } from "../api"
import { useError } from "../hooks/useError"
import { Brand } from "../components/Brand"
import { PageSkeleton } from "../components/PageSkeleton"
import { StatusBadge } from "../components/StatusBadge"
import { BackIcon } from "../components/icons"
import type { WorkspaceSnapshot } from "../types/workspace"
import { statusDetail, statusSince } from "../utils/taskStatus"
import { UNASSIGNED_REF } from "../utils/workPackages"
import { TaskDetailPanel } from "./TaskDetailPanel"
import styles from "./TaskWorkspace.module.css"

export function TaskWorkspace(props: {
    workPackageRef: string
    taskRef: string
    snapshot: WorkspaceSnapshot
    back: () => void
    openTask: (ref: string) => void
    openNote: (path: string) => void
    changed: () => void
    revision: number
}) {
    const task = createMemo(() => api.getTask(props.taskRef))
    const workPackage = createMemo(async () =>
        props.workPackageRef === UNASSIGNED_REF
            ? null
            : api.getWorkPackage(props.workPackageRef),
    )
    const [editing, setEditing] = createSignal(false)
    const [agentOpen, setAgentOpen] = createSignal(false)
    const [busy, setBusy] = createOptimistic("")
    const { capture, clear, message } = useError()
    const [note, setNote] = createSignal("")
    const blockers = () => {
        const detail = workPackage()
        return detail
            ? workPackageQueueBlockers(detail)
            : new Map<string, Task[]>()
    }

    createEffect(
        () => props.revision,
        () => {
            refresh(task)
            refresh(workPackage)
        },
    )

    const mutate = action(function* (
        label: string,
        request: () => Promise<unknown>,
        onSuccess?: () => void,
    ) {
        if (busy() || isPending(task) || isPending(workPackage)) return

        setBusy(label)
        clear()
        try {
            yield request()

            yield refresh(task)
            yield refresh(workPackage)
            props.changed()
            onSuccess?.()
        } catch (caught) {
            capture(caught)
        }
    })

    return (
        <main class={`${styles.scope} task-workspace min-h-screen`}>
            <Loading fallback={<PageSkeleton />}>
                <div class="mx-auto grid min-h-screen w-full max-w-[1720px] lg:grid-cols-[310px_1fr] xl:grid-cols-[340px_1fr]">
                    <aside class="task-sidebar sticky top-0 h-[100vh] overflow-auto p-[1.7rem] max-[820px]:relative max-[820px]:h-auto max-[820px]:p-[1rem_1.25rem] max-[820px]:[&_.brand]:hidden max-[820px]:[&_.back]:mt-0">
                        <Brand />
                        <button
                            class="back mt-8 inline-flex items-center gap-[0.35rem]"
                            onClick={props.back}>
                            <BackIcon />
                            Back to work package
                        </button>
                        <div class="sidebar-heading flex items-center justify-between m-[2.2rem_0_0.75rem] pb-[0.65rem] [&_h2]:m-0 [&_span]:m-0 max-[820px]:hidden">
                            <h2>Tasks in this work package</h2>
                            <span>
                                {workPackage()?.tasks.length ??
                                    props.snapshot.tasks.filter(
                                        (item) => !item.workPackageRef,
                                    ).length}
                            </span>
                        </div>
                        <div class="task-navigation m-[0_-0.7rem] max-[820px]:hidden">
                            <For
                                each={
                                    workPackage()?.tasks ??
                                    props.snapshot.tasks.filter(
                                        (item) => !item.workPackageRef,
                                    )
                                }>
                                {(item) => (
                                    <button
                                        class={`task-nav-item  relative block w-full p-[0.75rem_0.8rem] [&>span]:block [&>strong]:block [&>strong]:mt-[0.25rem] [&>strong]:overflow-hidden [&>.task-nav-meta]:flex [&>.task-nav-meta]:items-center [&>.task-nav-meta]:gap-[0.45rem] [&>.task-nav-detail]:mt-[0.25rem] [&>.task-nav-detail]:overflow-hidden`}
                                        aria-current={
                                            item.ref ===
                                            latest(() => props.taskRef)
                                                ? "page"
                                                : undefined
                                        }
                                        onClick={() => props.openTask(item.ref)}
                                        aria-busy={
                                            item.ref ===
                                                latest(() => props.taskRef) &&
                                            isPending(task)
                                                ? "true"
                                                : "false"
                                        }>
                                        <span class="task-nav-meta">
                                            {item.ref}
                                            <StatusBadge status={item.status} />
                                        </span>
                                        <strong>{item.title}</strong>
                                        <span
                                            class="task-nav-detail"
                                            title={
                                                statusSince(item)?.at ??
                                                undefined
                                            }>
                                            <Show
                                                when={
                                                    blockers().get(item.ref)
                                                        ?.length
                                                }>
                                                <em>
                                                    Blocked by{" "}
                                                    {blockers()
                                                        .get(item.ref)!
                                                        .map(
                                                            (blocker) =>
                                                                blocker.ref,
                                                        )
                                                        .join(", ")}
                                                    {" · "}
                                                </em>
                                            </Show>
                                            {statusDetail(item)}
                                        </span>
                                    </button>
                                )}
                            </For>
                        </div>
                    </aside>
                    <div
                        class="min-w-0"
                        aria-busy={
                            isPending(task) || isPending(workPackage)
                                ? "true"
                                : "false"
                        }
                        inert={isPending(task) || isPending(workPackage)}>
                        <TaskDetailPanel
                            task={task()}
                            workPackage={workPackage()}
                            workPackages={props.snapshot.workPackages}
                            busy={busy()}
                            error={message()}
                            editing={editing()}
                            setEditing={setEditing}
                            note={note()}
                            setNote={setNote}
                            mutate={mutate}
                            openAgent={() => setAgentOpen(true)}
                            openNote={props.openNote}
                            notesChanged={() => {
                                refresh(task)
                                props.changed()
                            }}
                        />
                    </div>
                </div>
                <Show when={agentOpen()}>
                    <Show when={workPackage()}>
                        {(detail) => (
                            <AgentLauncher
                                workPackage={detail()}
                                task={task()}
                                close={() => setAgentOpen(false)}
                                finished={() => {
                                    refresh(task)
                                    refresh(workPackage)
                                    props.changed()
                                }}
                            />
                        )}
                    </Show>
                </Show>
            </Loading>
        </main>
    )
}
