import {
    action,
    createMemo,
    createOptimistic,
    createSignal,
    For,
    Show,
} from "solid-js"
import { WORK_PACKAGE_COLORS } from "@shared/types"
import { api } from "../api"
import {
    BranchFields,
    branchDraftProblem,
    emptyBranchDraft,
    toNewBranchInput,
    type BranchDraft,
} from "../components/BranchFields"
import { PlusIcon } from "../components/icons"
import { Modal } from "../components/Modal"
import { useError } from "../hooks/useError"
import type { WorkspaceSnapshot } from "../types/workspace"

interface InvestigationDraft {
    title: string
    brief: string
}

export function CreateWorkPackage(props: {
    snapshot: WorkspaceSnapshot
    close: () => void
    created: (ref: string) => void
}) {
    const [name, setName] = createSignal("")
    const [color, setColor] = createSignal<string>(WORK_PACKAGE_COLORS[0])
    const [investigations, setInvestigations] = createSignal<
        InvestigationDraft[]
    >([])
    const [branches, setBranches] = createSignal<BranchDraft[]>([])
    const [busy, setBusy] = createOptimistic(false)
    const { capture, clear, Banner } = useError()

    const claimed = createMemo(
        () =>
            new Set(
                props.snapshot.workPackages.flatMap((workPackage) =>
                    workPackage.branchNames.map((branch) =>
                        branch.toLowerCase(),
                    ),
                ),
            ),
    )
    const problem = () => {
        const names = new Set<string>()
        for (const draft of branches()) {
            const issue = branchDraftProblem(
                draft,
                props.snapshot.localBranches,
                claimed(),
            )
            if (issue) return issue
            const branch = draft.branchName.trim().toLowerCase()
            if (branch && names.has(branch))
                return `'${draft.branchName.trim()}' is listed twice.`
            names.add(branch)
        }
        return null
    }

    const replace = <T,>(list: T[], index: number, value: T) =>
        list.map((item, at) => (at === index ? value : item))
    const without = <T,>(list: T[], index: number) =>
        list.filter((_, at) => at !== index)

    const submit = action(async function* () {
        if (busy() || problem()) return

        setBusy(true)
        clear()
        try {
            const result = await api.createWorkPackage({
                name: name(),
                color: color(),
                investigations: investigations().map((draft) => ({
                    title: draft.title.trim() || undefined,
                    brief: draft.brief,
                })),
                branches: branches().map(toNewBranchInput),
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
                Name the outcome, then add what it starts with: the questions an
                agent should investigate, and the branches the work will be
                delivered through. Both can be added later as tabs.
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

            <For each={investigations()} keyed={false}>
                {(draft, index) => (
                    <article class="tonal mt-4 grid gap-3 p-4">
                        <header class="flex items-center justify-between gap-3">
                            <h3 class="m-0">
                                Investigation
                                {investigations().length > 1
                                    ? ` ${index + 1}`
                                    : ""}
                            </h3>
                            <button
                                class="outlined"
                                onClick={() =>
                                    setInvestigations(
                                        without(investigations(), index),
                                    )
                                }>
                                Remove
                            </button>
                        </header>
                        <label class="field">
                            <span>
                                Title <small class="optional">(optional)</small>
                            </span>
                            <input
                                value={draft().title}
                                onInput={(event) =>
                                    setInvestigations(
                                        replace(investigations(), index, {
                                            ...draft(),
                                            title: event.currentTarget.value,
                                        }),
                                    )
                                }
                                placeholder={
                                    name().trim() || "The work package's name"
                                }
                            />
                        </label>
                        <label class="field">
                            <span>Brief</span>
                            <textarea
                                value={draft().brief}
                                onInput={(event) =>
                                    setInvestigations(
                                        replace(investigations(), index, {
                                            ...draft(),
                                            brief: event.currentTarget.value,
                                        }),
                                    )
                                }
                                placeholder="What should the agent investigate? Include the problem, context and any constraints."
                            />
                        </label>
                    </article>
                )}
            </For>

            <For each={branches()} keyed={false}>
                {(draft, index) => (
                    <article class="tonal mt-4 grid gap-3 p-4">
                        <header class="flex items-center justify-between gap-3">
                            <h3 class="m-0">
                                Branch
                                {branches().length > 1 ? ` ${index + 1}` : ""}
                            </h3>
                            <button
                                class="outlined"
                                onClick={() =>
                                    setBranches(without(branches(), index))
                                }>
                                Remove
                            </button>
                        </header>
                        <BranchFields
                            id={`create-work-package-branch-${index}`}
                            draft={draft()}
                            change={(next) =>
                                setBranches(replace(branches(), index, next))
                            }
                            localBranches={props.snapshot.localBranches}
                            currentBranch={props.snapshot.currentBranch}
                            claimed={claimed()}
                        />
                    </article>
                )}
            </For>

            <div class="mt-4 flex flex-wrap gap-2">
                <button
                    class="outlined"
                    onClick={() =>
                        setInvestigations([
                            ...investigations(),
                            { title: "", brief: "" },
                        ])
                    }>
                    <PlusIcon />
                    Add investigation
                </button>
                <button
                    class="outlined"
                    onClick={() =>
                        setBranches([...branches(), emptyBranchDraft()])
                    }>
                    <PlusIcon />
                    Add branch
                </button>
            </div>
            <Show when={!branches().length}>
                <p class="hint mt-2">
                    Without a branch, tasks are not merged anywhere until one is
                    added.
                </p>
            </Show>

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
                    disabled={!name().trim() || !!problem() || busy()}
                    title={problem() ?? undefined}
                    onClick={submit}>
                    Create work package
                </button>
            </div>
        </Modal>
    )
}
