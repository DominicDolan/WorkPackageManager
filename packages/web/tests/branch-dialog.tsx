import { render } from "@solidjs/web"
import type { WorkPackageDetail } from "@work-task-manager/shared"
import type { WorkspaceSnapshot } from "../src/types/workspace"
import { AddBranchDialog } from "../src/WorkPackageWorkspace/AddBranchDialog"
import { DialogContext } from "../src/hooks/useDialog"
import { api } from "../src/api"
import "../src/styles.css"
const root = document.getElementById("root")!
const results: string[] = []
const tick = () => new Promise((resolve) => setTimeout(resolve, 80))
function check(value: unknown, message: string) {
    if (!value) throw new Error(message)
    results.push(`PASS: ${message}`)
}
function deferred<T>() {
    let resolve!: (value: T) => void
    let reject!: (reason: Error) => void
    const promise = new Promise<T>((yes, no) => {
        resolve = yes
        reject = no
    })
    return { promise, resolve, reject }
}
function change(el: HTMLInputElement, value: string) {
    el.value = value
    el.dispatchEvent(new Event("input", { bubbles: true }))
}
function click(el: HTMLElement) {
    el.click()
}
async function run() {
    // Branch dialogs must survive an unresolved first query, refresh in place,
    // retain their draft on errors, and read Git again on every opening.
    const snapshot = {
        localBranches: ["main"],
        currentBranch: "main",
        workPackages: [],
    } as unknown as WorkspaceSnapshot
    const workPackage = {
        ref: "WP-1",
        baseBranch: "main",
        branches: [],
        tasks: [],
    } as unknown as WorkPackageDetail
    let branchRequest = deferred<Awaited<ReturnType<typeof api.listBranches>>>()
    let branchReads = 0
    api.listBranches = () => {
        branchReads++
        return branchRequest.promise
    }
    const mountBranches = () =>
        render(
            () => (
                <DialogContext value={document.createElement("dialog")}>
                    <AddBranchDialog
                        workPackage={workPackage}
                        snapshot={snapshot}
                        close={() => {}}
                        created={() => {}}
                    />
                </DialogContext>
            ),
            root,
        )
    const branchResult = (localBranches: string[]) => ({
        localBranches,
        currentBranch: "main",
        branches: [],
        defaultBase: "main",
    })
    const refreshButton = () =>
        [...root.querySelectorAll("button")].find(
            (button) => button.title === "Reload local Git branches",
        )!
    let disposeBranches = mountBranches()
    await tick()
    check(
        branchReads === 1,
        "opening a branch dialog fetches branches before the first response",
    )
    branchRequest.resolve(branchResult(["main", "fresh-on-open"]))
    await tick()
    check(
        root.querySelector('option[value="fresh-on-open"]'),
        "opening loads fresh base branch options",
    )
    const label = root.querySelector<HTMLInputElement>("input")!
    change(label, "Keep my draft")
    branchRequest = deferred()
    click(refreshButton())
    await tick()
    check(
        refreshButton().disabled,
        "branch refresh disables duplicate requests",
    )
    branchRequest.resolve(branchResult(["main", "fresh-on-refresh"]))
    await tick()
    check(
        root.querySelector('option[value="fresh-on-refresh"]'),
        "manual refresh updates base options",
    )
    check(
        root.querySelector<HTMLInputElement>("input")!.value ===
            "Keep my draft",
        "refresh preserves the draft",
    )
    click(
        [...root.querySelectorAll("button")].find(
            (button) => button.textContent === "Existing branch",
        )!,
    )
    await tick()
    const picker = root.querySelector<HTMLInputElement>('[role="combobox"]')!
    picker.focus()
    await tick()
    check(
        [...root.querySelectorAll('[role="option"]')].some((option) =>
            option.textContent?.includes("fresh-on-refresh"),
        ),
        "existing branch picker uses the refreshed list",
    )
    branchRequest = deferred()
    click(refreshButton())
    await tick()
    branchRequest.reject(new Error("Git unavailable"))
    await tick()
    check(
        root.textContent?.includes(
            "Unable to refresh branches: Git unavailable",
        ),
        "branch refresh failures show an inline error",
    )
    check(
        !refreshButton().disabled &&
            root.querySelector<HTMLInputElement>("input")!.value ===
                "Keep my draft",
        "failed refresh preserves the draft and permits retry",
    )
    disposeBranches()
    branchRequest = deferred()
    disposeBranches = mountBranches()
    await tick()
    check(branchReads === 4, "reopening the dialog fetches branches again")
    branchRequest.resolve(branchResult(["main", "fresh-on-reopen"]))
    await tick()
    check(
        root.querySelector('option[value="fresh-on-reopen"]'),
        "reopening shows the latest branches",
    )
    disposeBranches()
    document.getElementById("results")!.textContent =
        results.join("\n") + "\nALL CHECKS PASSED"
}
void run().catch((error) => {
    document.getElementById("results")!.textContent =
        results.join("\n") + `\nFAIL: ${error.stack ?? error}`
})
