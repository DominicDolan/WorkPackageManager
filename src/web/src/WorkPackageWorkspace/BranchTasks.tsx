import {
    type WorkPackageBranchDetail,
    type WorkPackageDetail,
} from "@shared/types"
import {
    action,
    createEffect,
    createOptimistic,
    createSignal,
    For,
    Show,
} from "solid-js"
import { api } from "../api"
import { StatusBadge } from "../components/StatusBadge"
import { useError } from "../hooks/useError"

/**
 * Which of the work package's tasks this branch delivers.
 *
 * A task on several branches is cut from the first and merged into all of
 * them, so each row says where else it goes.
 */
export function BranchTasks(props: {
    workPackage: WorkPackageDetail
    branch: WorkPackageBranchDetail
    changed: () => void
}) {
    const [selected, setSelected] = createSignal<Set<string>>(new Set())
    const [busy, setBusy] = createOptimistic(false)
    const { capture, clear, Banner } = useError()

    const reset = () =>
        setSelected(
            new Set(props.branch.taskRefs.map((ref) => ref.toLowerCase())),
        )
    createEffect(
        () => props.branch.taskRefs.join(","),
        () => {
            reset()
        },
    )

    const has = (ref: string) => selected().has(ref.toLowerCase())
    const toggle = (ref: string) => {
        const next = new Set(selected())
        const key = ref.toLowerCase()
        if (next.has(key)) next.delete(key)
        else next.add(key)
        setSelected(next)
    }
    const chosen = () =>
        props.workPackage.tasks
            .map((task) => task.ref)
            .filter((ref) => has(ref))
    const dirty = () => {
        const saved = new Set(
            props.branch.taskRefs.map((ref) => ref.toLowerCase()),
        )
        return (
            saved.size !== selected().size ||
            [...selected()].some((ref) => !saved.has(ref))
        )
    }
    const elsewhere = (targets: string[]) =>
        targets.filter(
            (name) =>
                name.toLowerCase() !== props.branch.branchName.toLowerCase(),
        )

    const save = action(function* () {
        if (busy()) return
        setBusy(true)
        clear()
        try {
            yield api.updateWorkPackageBranch(
                props.workPackage.ref,
                props.branch.id,
                { taskRefs: chosen() },
            )
            props.changed()
        } catch (caught) {
            capture(caught)
        }
    })

    return (
        <article class="tonal p-5">
            <header class="flex flex-wrap items-start justify-between gap-3">
                <div>
                    <h3 class="m-0">Tasks on this branch</h3>
                    <p class="m-[0.28rem_0_0]">
                        Each task is merged into every branch it is on, and cut
                        from the first of them.
                    </p>
                </div>
                <div class="flex gap-2">
                    <button
                        class="outlined"
                        disabled={busy() || !dirty()}
                        onClick={reset}>
                        Undo
                    </button>
                    <button
                        class="primary"
                        aria-busy={busy() ? "true" : "false"}
                        disabled={busy() || !dirty()}
                        onClick={save}>
                        Save tasks
                    </button>
                </div>
            </header>
            <Banner />
            <ul class="mt-4 grid gap-1 p-0" style={{ "list-style": "none" }}>
                <For
                    each={props.workPackage.tasks}
                    fallback={
                        <li class="hint">
                            This work package has no tasks yet.
                        </li>
                    }>
                    {(task) => (
                        <li>
                            <label class="choice flex items-center gap-3 py-1">
                                <input
                                    type="checkbox"
                                    checked={has(task.ref)}
                                    disabled={busy()}
                                    onChange={() => toggle(task.ref)}
                                />
                                <span class="font-mono caption muted w-12">
                                    {task.ref}
                                </span>
                                <span class="min-w-0 flex-1 truncate text-sm">
                                    {task.title}
                                </span>
                                <Show when={!task.useGitWorkflow}>
                                    <small class="badge p-[0.12rem_0.42rem]">
                                        No Git
                                    </small>
                                </Show>
                                <Show
                                    when={
                                        elsewhere(task.targetBranches).length
                                    }>
                                    {(count) => (
                                        <small
                                            class="caption muted"
                                            title={elsewhere(
                                                task.targetBranches,
                                            ).join(", ")}>
                                            {has(task.ref) ? "also on" : "on"}{" "}
                                            {count()} other{" "}
                                            {count() === 1
                                                ? "branch"
                                                : "branches"}
                                        </small>
                                    )}
                                </Show>
                                <StatusBadge status={task.status} />
                            </label>
                        </li>
                    )}
                </For>
            </ul>
        </article>
    )
}
