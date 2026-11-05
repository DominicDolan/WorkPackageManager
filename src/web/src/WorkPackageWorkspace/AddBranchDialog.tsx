import { type WorkPackageDetail } from "@shared/types"
import {
    action,
    createMemo,
    createOptimistic,
    createSignal,
    Loading,
    refresh,
    Show,
} from "solid-js"
import { api } from "../api"
import {
    BranchFields,
    branchDraftProblem,
    emptyBranchDraft,
    toNewBranchInput,
} from "../components/BranchFields"
import { Modal } from "../components/Modal"
import { createQuery } from "../hooks/createQuery"
import { useError } from "../hooks/useError"
import type { WorkspaceSnapshot } from "../types/workspace"

export function AddBranchDialog(props: {
    workPackage: WorkPackageDetail
    snapshot: WorkspaceSnapshot
    close: () => void
    created: (id: number) => void
}) {
    const [draft, setDraft] = createSignal(emptyBranchDraft())
    const [busy, setBusy] = createOptimistic(false)
    const { capture, clear, Banner } = useError()
    const [refreshing, setRefreshing] = createOptimistic(false)
    let lastBranches = {
        localBranches: props.snapshot.localBranches,
        currentBranch: props.snapshot.currentBranch,
    }
    // Each dialog opening mounts a fresh query. Keep the last usable list if
    // Git cannot be read, and leave the draft intact when refreshing it.
    const branches = createQuery(async () => {
        try {
            const result = await api.listBranches()
            lastBranches = {
                localBranches: result.localBranches,
                currentBranch: result.currentBranch,
            }
            return { ...lastBranches, error: "" }
        } catch (caught) {
            return {
                ...lastBranches,
                error: `Unable to refresh branches: ${caught instanceof Error ? caught.message : String(caught)}`,
            }
        }
    })
    // JSX fallback controls can evaluate before Loading has a first result.
    const branchList = () => branches.value ?? props.snapshot
    const refreshBranches = action(function* () {
        if (refreshing()) return
        setRefreshing(true)
        yield refresh(branches)
    })
    const claimed = createMemo(
        () =>
            new Set(
                props.snapshot.workPackages.flatMap((one) =>
                    one.branchNames.map((name) => name.toLowerCase()),
                ),
            ),
    )
    // Mirrors the server's default: unfinished tasks, plus finished ones no
    // other branch delivers.
    const open = () => {
        const onSibling = new Set(
            props.workPackage.branches.flatMap((one) =>
                one.taskRefs.map((ref) => ref.toLowerCase()),
            ),
        )
        return props.workPackage.tasks.filter(
            (task) =>
                task.status === "backlog" ||
                task.status === "in_progress" ||
                ((task.status === "dev_complete" ||
                    task.status === "verified") &&
                    !onSibling.has(task.ref.toLowerCase())),
        )
    }
    // Set when the branch was added but some finished task's commits could not
    // be put on it, so the dialog stays open to say which.
    const [added, setAdded] = createSignal<number | null>(null)
    const [partialDelivery, setPartialDelivery] = createSignal("")
    const problem = () =>
        branchDraftProblem(draft(), branchList().localBranches, claimed())

    const submit = action(async function* () {
        if (busy() || problem()) return
        setBusy(true)
        clear()
        try {
            const result = await api.addWorkPackageBranch(
                props.workPackage.ref,
                toNewBranchInput(draft()),
            )
            yield
            if (result.git?.problems.length) {
                setAdded(result.branch.id)
                setPartialDelivery(result.git.problems.join("\n\n"))
                return
            }
            props.created(result.branch.id)
        } catch (caught) {
            yield
            capture(caught)
        }
    })

    return (
        <Modal title="Add a branch" close={props.close}>
            <Loading fallback={<p class="hint">Loading branches…</p>}>
                <div class="mb-3 flex justify-end">
                    <button
                        type="button"
                        class="outlined px-2 py-1 text-sm"
                        title="Reload local Git branches"
                        disabled={refreshing()}
                        aria-busy={refreshing() ? "true" : "false"}
                        onClick={refreshBranches}>
                        <span aria-hidden="true">↻</span>{" "}
                        {refreshing() ? "Refreshing…" : "Refresh branches"}
                    </button>
                </div>
                <Show when={branches.value?.error}>
                    <p class="notice error mb-4" role="alert">
                        {branches.value?.error}
                    </p>
                </Show>
                <BranchFields
                    id="add-branch"
                    draft={draft()}
                    change={setDraft}
                    localBranches={branchList().localBranches}
                    currentBranch={branchList().currentBranch}
                    claimed={claimed()}
                    baseBranch={props.workPackage.baseBranch}
                />
                <p class="description mt-4">
                    {open().length
                        ? `${open().length} task(s) go on it: those not yet Dev Complete, and finished ones no other branch has, whose commits are added now. Change that from the branch's tab.`
                        : "No tasks are waiting, so it starts empty. New tasks join the newest branch."}
                </p>
                <Show when={partialDelivery()}>
                    <section class="notice error mt-4" role="alert">
                        <strong>
                            Branch created with incomplete delivery.
                        </strong>
                        <p class="m-[0.35rem_0_0]">
                            Tasks whose commits could not be replayed were left
                            off this branch. Resolve the conflict, then add them
                            from the branch’s Tasks section.
                        </p>
                        <pre class="m-[0.75rem_0_0] whitespace-pre-wrap text-sm">
                            {partialDelivery()}
                        </pre>
                    </section>
                </Show>
                <Banner />
                <div class="mt-5 flex justify-end gap-2">
                    <button
                        class="outlined"
                        onClick={() => {
                            const id = added()
                            if (id === null) props.close()
                            else props.created(id)
                        }}>
                        {added() === null ? "Cancel" : "Close"}
                    </button>
                    <Show
                        when={added()}
                        fallback={
                            <button
                                class="primary"
                                aria-busy={busy() ? "true" : "false"}
                                disabled={busy() || !!problem()}
                                onClick={submit}>
                                Add branch
                            </button>
                        }>
                        {(id) => (
                            <button
                                class="primary"
                                onClick={() => props.created(id())}>
                                Open branch
                            </button>
                        )}
                    </Show>
                </div>
            </Loading>
        </Modal>
    )
}
