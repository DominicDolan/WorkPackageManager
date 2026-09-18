import { For, Show, createMemo, createSignal } from "solid-js"
import type { NewBranchInput } from "../api"

/** A branch being described, before it exists. */
export interface BranchDraft {
    /** The tab's name. Blank lets the server number it. */
    label: string
    /** Cut a new branch, or adopt one that is already there. */
    mode: "new" | "existing"
    /** For `new`, blank means "name it after the work package". For
     *  `existing`, the branch being adopted. */
    branchName: string
    /** What a new branch is cut from. Blank means the repository's base. */
    baseBranch: string
}

export const emptyBranchDraft = (): BranchDraft => ({
    label: "",
    mode: "new",
    branchName: "",
    baseBranch: "",
})

/** Why a draft cannot be submitted yet, or null when it can. */
export function branchDraftProblem(
    draft: BranchDraft,
    localBranches: readonly string[],
    claimed: ReadonlySet<string>,
): string | null {
    const name = draft.branchName.trim()
    if (draft.mode === "existing") {
        if (!name) return "Choose the branch to use."
        if (!localBranches.includes(name))
            return `There is no local branch '${name}'.`
    } else if (name && localBranches.includes(name)) {
        return `'${name}' already exists. Choose "Existing branch" to use it.`
    }
    if (name && claimed.has(name.toLowerCase()))
        return `'${name}' already belongs to a work package.`
    return null
}

export function toNewBranchInput(draft: BranchDraft): NewBranchInput {
    return {
        label: draft.label.trim() || undefined,
        branchName: draft.branchName.trim() || undefined,
        existing: draft.mode === "existing",
        baseBranch:
            draft.mode === "new" ? draft.baseBranch.trim() || null : null,
    }
}

/**
 * The fields that describe a work package branch: a tab name, and either a
 * new Git branch (name and base) or an existing local one to adopt.
 */
export function BranchFields(props: {
    id: string
    draft: BranchDraft
    change: (draft: BranchDraft) => void
    localBranches: readonly string[]
    currentBranch: string | null
    /** Lower-cased names already taken by a work package branch. */
    claimed: ReadonlySet<string>
    /** The repository's base branch, for the "cut from" placeholder. */
    baseBranch?: string
}) {
    const set = (patch: Partial<BranchDraft>) =>
        props.change({ ...props.draft, ...patch })
    const problem = () =>
        branchDraftProblem(props.draft, props.localBranches, props.claimed)
    const baseDefault = () =>
        props.baseBranch
            ? `${props.baseBranch} (the base branch)`
            : "the base branch"

    return (
        <div class="grid gap-4">
            <label class="field">
                <span>
                    Tab name <small class="optional">(optional)</small>
                </span>
                <input
                    value={props.draft.label}
                    onInput={(event) =>
                        set({ label: event.currentTarget.value })
                    }
                    placeholder="e.g. Release fix"
                />
            </label>
            <div
                role="group"
                class="segmented flex w-fit"
                aria-label="Branch source">
                <button
                    type="button"
                    aria-pressed={props.draft.mode === "new" ? "true" : "false"}
                    onClick={() => set({ mode: "new", branchName: "" })}>
                    New branch
                </button>
                <button
                    type="button"
                    aria-pressed={
                        props.draft.mode === "existing" ? "true" : "false"
                    }
                    onClick={() => set({ mode: "existing", branchName: "" })}>
                    Existing branch
                </button>
            </div>
            <Show
                when={props.draft.mode === "new"}
                fallback={
                    <BranchPicker
                        id={`${props.id}-existing`}
                        value={props.draft.branchName}
                        change={(branchName) => set({ branchName })}
                        branches={props.localBranches}
                        currentBranch={props.currentBranch}
                        claimed={props.claimed}
                    />
                }>
                <div class="grid gap-4 sm:grid-cols-2">
                    <label class="field">
                        <span>
                            Branch name{" "}
                            <small class="optional">(optional)</small>
                        </span>
                        <input
                            class="code"
                            value={props.draft.branchName}
                            onInput={(event) =>
                                set({ branchName: event.currentTarget.value })
                            }
                            placeholder="Named after the work package"
                        />
                    </label>
                    <label class="field">
                        <span>Cut from</span>
                        <select
                            class="code"
                            value={props.draft.baseBranch}
                            onChange={(event) =>
                                set({ baseBranch: event.currentTarget.value })
                            }>
                            <option value="">{baseDefault()}</option>
                            <For each={props.localBranches}>
                                {(branch) => (
                                    <option value={branch}>{branch}</option>
                                )}
                            </For>
                        </select>
                    </label>
                </div>
            </Show>
            <small class={problem() ? "hint notice warning" : "hint"}>
                {problem() ??
                    (props.draft.mode === "new"
                        ? "The Git branch is created the first time a task on it is started."
                        : "Its existing commits are kept. New work is merged on top.")}
            </small>
        </div>
    )
}

/** A searchable list of local branches, with the ones already taken disabled. */
function BranchPicker(props: {
    id: string
    value: string
    change: (branch: string) => void
    branches: readonly string[]
    currentBranch: string | null
    claimed: ReadonlySet<string>
}) {
    const [open, setOpen] = createSignal(false)
    const options = createMemo(() =>
        [...props.branches].sort((left, right) => {
            if (left === props.currentBranch) return -1
            if (right === props.currentBranch) return 1
            return left.localeCompare(right)
        }),
    )
    const matching = createMemo(() => {
        const query = props.value.trim().toLowerCase()
        return options().filter(
            (branch) => !query || branch.toLowerCase().includes(query),
        )
    })
    const taken = (branch: string) => props.claimed.has(branch.toLowerCase())
    const choose = (branch: string) => {
        if (taken(branch)) return
        props.change(branch)
        setOpen(false)
    }

    return (
        <div class="field">
            <label class="label" for={props.id}>
                Branch
            </label>
            <div class="relative">
                <input
                    id={props.id}
                    class="code"
                    value={props.value}
                    onInput={(event) => {
                        props.change(event.currentTarget.value)
                        setOpen(true)
                    }}
                    onFocus={() => setOpen(true)}
                    onBlur={() => setOpen(false)}
                    onKeyDown={(event) => {
                        if (event.key === "Escape") setOpen(false)
                        if (event.key === "Enter" && open()) {
                            const first = matching().find(
                                (branch) => !taken(branch),
                            )
                            if (first) {
                                event.preventDefault()
                                choose(first)
                            }
                        }
                    }}
                    placeholder="Search local branches…"
                    autocomplete="off"
                    role="combobox"
                    aria-expanded={open() ? "true" : "false"}
                    aria-controls={`${props.id}-options`}
                    aria-autocomplete="list"
                />
                <Show when={open()}>
                    <div
                        id={`${props.id}-options`}
                        class="menu absolute z-[10] top-[calc(100%_+_0.3rem)] left-0 right-0 max-h-[15rem] overflow-y-auto p-[0.3rem]"
                        role="listbox">
                        <For
                            each={matching()}
                            fallback={
                                <p class="hint m-0 p-[0.75rem]">
                                    No branches match your search.
                                </p>
                            }>
                            {(branch) => (
                                <button
                                    type="button"
                                    class={`option ${taken(branch) ? "muted" : ""} flex w-full items-center justify-between gap-[1rem] p-[0.62rem_0.65rem]`}
                                    disabled={taken(branch)}
                                    role="option"
                                    aria-selected={
                                        props.value === branch
                                            ? "true"
                                            : "false"
                                    }
                                    onMouseDown={(event) => {
                                        event.preventDefault()
                                        choose(branch)
                                    }}>
                                    <code class="overflow-hidden">
                                        {branch}
                                    </code>
                                    <span class="muted flex flex-none items-center gap-[0.45rem]">
                                        <Show
                                            when={
                                                branch === props.currentBranch
                                            }>
                                            <small class="badge info p-[0.12rem_0.42rem]">
                                                Current
                                            </small>
                                        </Show>
                                        <Show when={taken(branch)}>
                                            <small>Already assigned</small>
                                        </Show>
                                    </span>
                                </button>
                            )}
                        </For>
                    </div>
                </Show>
            </div>
        </div>
    )
}
