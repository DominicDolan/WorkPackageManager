import {
    action,
    createOptimistic,
    For,
    Show,
    createMemo,
    createSignal,
} from "solid-js"
import { WORK_PACKAGE_COLORS } from "@shared/types"
import { api } from "../api"
import { useError } from "../hooks/useError"
import { Modal } from "../components/Modal"
import type { WorkspaceSnapshot } from "../types/workspace"

export function CreateWorkPackage(props: {
    snapshot: WorkspaceSnapshot
    close: () => void
    created: (ref: string) => void
}) {
    const [name, setName] = createSignal("")
    const [description, setDescription] = createSignal("")
    const [color, setColor] = createSignal<string>(WORK_PACKAGE_COLORS[0])
    const [branchName, setBranchName] = createSignal("")
    const [branchMenuOpen, setBranchMenuOpen] = createSignal(false)
    const [busy, setBusy] = createOptimistic(false)
    const { capture, clear, Banner } = useError()
    const claimedBranches = createMemo(
        () =>
            new Set(
                props.snapshot.workPackages.map((workPackage) =>
                    workPackage.branchName.toLowerCase(),
                ),
            ),
    )
    const branchOptions = createMemo(() =>
        [...props.snapshot.localBranches].sort((left, right) => {
            if (left === props.snapshot.currentBranch) return -1
            if (right === props.snapshot.currentBranch) return 1
            return left.localeCompare(right)
        }),
    )
    const matchingBranches = createMemo(() => {
        const query = branchName().trim().toLowerCase()
        return branchOptions().filter(
            (branch) => !query || branch.toLowerCase().includes(query),
        )
    })
    const selectedBranchValid = createMemo(() => {
        const branch = branchName().trim()
        return (
            !branch ||
            (props.snapshot.localBranches.includes(branch) &&
                !claimedBranches().has(branch.toLowerCase()))
        )
    })

    const chooseBranch = (branch: string) => {
        if (claimedBranches().has(branch.toLowerCase())) return
        setBranchName(branch)
        setBranchMenuOpen(false)
    }

    const submit = action(async function* () {
        if (busy()) return

        setBusy(true)
        clear()
        try {
            const result = await api.createWorkPackage({
                name: name(),
                description: description(),
                investigation: description(),
                color: color(),
                branchName: branchName().trim() || undefined,
            })
            yield
            props.created(result.workPackage.ref)
        } catch (caught) {
            yield
            capture(caught)
        }
    })

    return (
        <Modal title="Create work package" close={props.close}>
            <p class="description m-0">
                Define the outcome, then give an agent the question and context
                it needs to investigate. The tasks it creates will be filed into
                this work package.
            </p>
            <label class="field mt-4">
                <span>Work package name</span>
                <input
                    autofocus
                    value={name()}
                    onInput={(event) => setName(event.currentTarget.value)}
                    placeholder="e.g. Improve release confidence"
                />
            </label>
            <label class="field mt-4">
                <span>Investigation</span>
                <textarea
                    value={description()}
                    onInput={(event) =>
                        setDescription(event.currentTarget.value)
                    }
                    placeholder="What should the agent investigate? Include the problem, context and any constraints."
                />
            </label>
            <div class="field mt-4">
                <label class="label" for="create-work-package-branch">
                    Existing branch <small class={"optional"}>(optional)</small>
                </label>
                <div class="relative">
                    <input
                        id="create-work-package-branch"
                        class={"code"}
                        value={branchName()}
                        onInput={(event) => {
                            setBranchName(event.currentTarget.value)
                            setBranchMenuOpen(true)
                        }}
                        onFocus={() => setBranchMenuOpen(true)}
                        onBlur={() => setBranchMenuOpen(false)}
                        onKeyDown={(event) => {
                            if (event.key === "Escape") setBranchMenuOpen(false)
                            if (event.key === "Enter" && branchMenuOpen()) {
                                const first = matchingBranches().find(
                                    (branch) =>
                                        !claimedBranches().has(
                                            branch.toLowerCase(),
                                        ),
                                )
                                if (first) {
                                    event.preventDefault()
                                    chooseBranch(first)
                                }
                            }
                        }}
                        placeholder="Search local branches…"
                        autocomplete="off"
                        role="combobox"
                        aria-expanded={branchMenuOpen() ? "true" : "false"}
                        aria-controls="create-work-package-branch-options"
                        aria-autocomplete="list"
                    />
                    <Show when={branchMenuOpen()}>
                        <div
                            id="create-work-package-branch-options"
                            class="menu absolute z-[10] top-[calc(100%_+_0.3rem)] left-0 right-0 max-h-[15rem] overflow-y-auto p-[0.3rem]"
                            role="listbox">
                            <For
                                each={matchingBranches()}
                                fallback={
                                    <p class="hint m-0 p-[0.75rem]">
                                        No branches match your search.
                                    </p>
                                }>
                                {(branch) => {
                                    const claimed = () =>
                                        claimedBranches().has(
                                            branch.toLowerCase(),
                                        )
                                    return (
                                        <button
                                            type="button"
                                            class={`option ${claimed() ? "muted" : ""} flex w-full items-center justify-between gap-[1rem] p-[0.62rem_0.65rem] [&_code]:overflow-hidden`}
                                            disabled={claimed()}
                                            role="option"
                                            aria-selected={
                                                branchName() === branch
                                                    ? "true"
                                                    : "false"
                                            }
                                            onMouseDown={(event) => {
                                                event.preventDefault()
                                                chooseBranch(branch)
                                            }}>
                                            <code>{branch}</code>
                                            <span class="muted flex flex-none items-center gap-[0.45rem]">
                                                <Show
                                                    when={
                                                        branch ===
                                                        props.snapshot
                                                            .currentBranch
                                                    }>
                                                    <small class="badge info p-[0.12rem_0.42rem]">
                                                        Current
                                                    </small>
                                                </Show>
                                                <Show when={claimed()}>
                                                    <small>
                                                        Already assigned
                                                    </small>
                                                </Show>
                                            </span>
                                        </button>
                                    )
                                }}
                            </For>
                        </div>
                    </Show>
                </div>
                <small class={"hint"}>
                    {selectedBranchValid()
                        ? "Select a local branch to use for this work package. Leave blank to generate a new work package branch."
                        : "Choose an available branch from the results, or clear the field."}
                </small>
            </div>
            <div class="mt-4">
                <span class="label">Colour</span>
                <div class="mt-2 flex gap-2">
                    <For each={WORK_PACKAGE_COLORS}>
                        {(value) => (
                            <button
                                aria-label={value}
                                class="swatch h-8 w-8"
                                aria-pressed={
                                    color() === value ? "true" : "false"
                                }
                                style={{ background: value }}
                                onClick={() => setColor(value)}
                            />
                        )}
                    </For>
                </div>
            </div>
            <Banner />
            <div class="mt-5 flex justify-end gap-2">
                <button class="outlined" onClick={props.close}>
                    Cancel
                </button>
                <button
                    aria-busy={busy() ? "true" : "false"}
                    class="primary"
                    disabled={
                        !name().trim() || !selectedBranchValid() || busy()
                    }
                    onClick={submit}>
                    Create work package
                </button>
            </div>
        </Modal>
    )
}
