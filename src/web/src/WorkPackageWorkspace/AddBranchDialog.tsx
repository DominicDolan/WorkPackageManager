import { type WorkPackageDetail } from "@shared/types"
import { action, createMemo, createOptimistic, createSignal } from "solid-js"
import { api } from "../api"
import {
    BranchFields,
    branchDraftProblem,
    emptyBranchDraft,
    toNewBranchInput,
} from "../components/BranchFields"
import { Modal } from "../components/Modal"
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
    const claimed = createMemo(
        () =>
            new Set(
                props.snapshot.workPackages.flatMap((one) =>
                    one.branchNames.map((name) => name.toLowerCase()),
                ),
            ),
    )
    const open = () =>
        props.workPackage.tasks.filter(
            (task) =>
                task.status === "backlog" || task.status === "in_progress",
        )
    const problem = () =>
        branchDraftProblem(draft(), props.snapshot.localBranches, claimed())

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
            props.created(result.branch.id)
        } catch (caught) {
            yield
            capture(caught)
        }
    })

    return (
        <Modal title="Add a branch" close={props.close}>
            <BranchFields
                id="add-branch"
                draft={draft()}
                change={setDraft}
                localBranches={props.snapshot.localBranches}
                currentBranch={props.snapshot.currentBranch}
                claimed={claimed()}
                baseBranch={props.workPackage.baseBranch}
            />
            <p class="description mt-4">
                {open().length
                    ? `The ${open().length} task(s) not yet Dev Complete go on it. Change that from the branch's tab.`
                    : "No tasks are waiting, so it starts empty. New tasks join the newest branch."}
            </p>
            <Banner />
            <div class="mt-5 flex justify-end gap-2">
                <button class="outlined" onClick={props.close}>
                    Cancel
                </button>
                <button
                    class="primary"
                    aria-busy={busy() ? "true" : "false"}
                    disabled={busy() || !!problem()}
                    onClick={submit}>
                    Add branch
                </button>
            </div>
        </Modal>
    )
}
