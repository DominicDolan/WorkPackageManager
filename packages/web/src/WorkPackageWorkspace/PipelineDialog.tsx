import {
    BRANCH_STEP_LABELS,
    BRANCH_STEPS,
    INVESTIGATION_STATUS_LABELS,
    RECOMMENDED_MODEL,
    STATUS_LABELS,
    type AgentHarnessId,
    type AgentPermissionMode,
    type WorkPackageDetail,
} from "@work-task-manager/shared"
import {
    action,
    createEffect,
    createMemo,
    createOptimistic,
    createSignal,
    For,
    isPending,
    Loading,
    Show,
    untrack,
    type Element,
} from "solid-js"
import { api } from "../api"
import { AgentSettings } from "../components/AgentSettings"
import {
    BranchFields,
    branchDraftProblem,
    emptyBranchDraft,
    toNewBranchInput,
} from "../components/BranchFields"
import { Modal } from "../components/Modal"
import { ModelPicker } from "../components/ModelPicker"
import { PlusIcon } from "../components/icons"
import { useError } from "../hooks/useError"
import type { WorkspaceSnapshot } from "../types/workspace"

/**
 * "Work with an agent": work the whole package start to finish. Investigations
 * first, then task runs over what they filed, then each branch through rebase,
 * description, checks and pull request. One agent investigates and supervises
 * all of it.
 */
export function PipelineDialog(props: {
    workPackage: WorkPackageDetail
    snapshot: WorkspaceSnapshot
    close: () => void
    /** The work package changed: an investigation or branch was added here. */
    changed: () => void
    /** Told the id of the Run tab the run was recorded as. */
    started: (workRunId: number) => void
}) {
    const environment = createMemo(() => api.agentEnvironment())
    const [harness, setHarness] = createSignal("")
    const [model, setModel] = createSignal("")
    const [permission, setPermission] =
        createSignal<AgentPermissionMode>("bypassPermissions")
    const [extra, setExtra] = createSignal("")
    const [label, setLabel] = createSignal("")

    // What hasn't been run yet, the task run when there is or will be work
    // for it, and every branch without a PR.
    const [investigations, setInvestigations] = createSignal<
        ReadonlySet<string>
    >(
        new Set(
            untrack(() =>
                props.workPackage.investigations
                    .filter((item) => item.status !== "complete")
                    .map((item) => item.ref),
            ),
        ),
    )
    const [working, setWorking] = createSignal(
        untrack(
            () =>
                props.workPackage.queue.length > 0 ||
                props.workPackage.investigations.some(
                    (item) => item.status !== "complete",
                ),
        ),
    )
    const [taskModel, setTaskModel] = createSignal(RECOMMENDED_MODEL)
    const [taskExtra, setTaskExtra] = createSignal("")
    const [taskMode, setTaskMode] = createSignal<"all" | "selected">("all")
    const [taskSelection, setTaskSelection] = createSignal<ReadonlySet<string>>(
        new Set(untrack(() => props.workPackage.queue.map((task) => task.ref))),
    )
    const selectedTasks = () =>
        props.workPackage.queue.filter((task) => taskSelection().has(task.ref))
    const hasTaskRun = () =>
        working() && (taskMode() === "all" || selectedTasks().length > 0)
    const [branches, setBranches] = createSignal<ReadonlySet<number>>(
        new Set(
            untrack(() =>
                props.workPackage.branches
                    .filter((branch) => !branch.delivery?.prUrl)
                    .map((branch) => branch.id),
            ),
        ),
    )

    const [busy, setBusy] = createOptimistic("")
    const { capture, clear, Banner } = useError()

    const chosenHarness = () =>
        harness() ||
        environment().harnesses.find(
            (item) => item.id === "claude" && item.available,
        )?.id ||
        environment().harnesses.find((item) => item.available)?.id ||
        ""
    createEffect(
        () => environment(),
        (env) => {
            if (
                env.harnesses.some(
                    (item) => item.id === harness() && item.available,
                )
            )
                return
            setHarness(
                env.harnesses.find(
                    (item) => item.id === "claude" && item.available,
                )?.id ??
                    env.harnesses.find((item) => item.available)?.id ??
                    "",
            )
        },
    )
    // Task agents share the run's harness, so their models come from its
    // catalogue.
    const models = createMemo(async () => {
        const current = chosenHarness()
        return current ? await api.agentModels(current).catch(() => []) : []
    })

    const toggle = <T,>(set: ReadonlySet<T>, value: T, on: boolean) => {
        const next = new Set(set)
        if (on) next.add(value)
        else next.delete(value)
        return next
    }
    const nothingChosen = () =>
        !investigations().size && !hasTaskRun() && !branches().size

    const start = action(async function* () {
        if (busy() || isPending(harness) || nothingChosen()) return
        setBusy("start")
        clear()
        try {
            const selectedHarness = chosenHarness()
            if (!selectedHarness)
                throw new Error("No supported agent harness is installed.")
            const agent = {
                harness: selectedHarness as AgentHarnessId,
                model: model(),
                permissionMode: permission(),
                extra: extra(),
            }
            const result = await api.startWorkRun(props.workPackage.ref, {
                kind: "pipeline",
                label: label().trim() || undefined,
                harness: agent.harness,
                model: agent.model,
                mode: "print",
                permissionMode: agent.permissionMode,
                extra: agent.extra,
                plan: {
                    agent,
                    // In the work package's order, whatever order they were ticked.
                    investigations: props.workPackage.investigations
                        .filter((item) => investigations().has(item.ref))
                        .map((item) => item.ref),
                    taskRun: hasTaskRun()
                        ? {
                              model: taskModel(),
                              extra: taskExtra(),
                              selected:
                                  taskMode() === "selected"
                                      ? selectedTasks().map((task) => task.ref)
                                      : undefined,
                          }
                        : null,
                    branches: props.workPackage.branches
                        .filter((branch) => branches().has(branch.id))
                        .map((branch) => branch.id),
                },
            })
            yield
            props.changed()
            props.started(result.workRun.id)
            props.close()
        } catch (caught) {
            yield
            capture(caught)
        }
    })

    return (
        <Modal title="Work with an agent" close={props.close}>
            <p class="description m-[0_0_1rem]">
                Works this package from start to finish: the investigations,
                then tasks according to your chosen mode, then each branch
                through to a pull request. It gets a Run tab of its own.
            </p>

            <section>
                <h3 class="m-0">Agent</h3>
                <p class="caption muted m-[0.25rem_0_0]">
                    It runs the investigations, and it is the supervisor the
                    task run, the rebase and the checks call in when they stop
                    short.
                </p>
                <Loading
                    fallback={
                        <p class="mt-5 description">
                            Checking installed agents…
                        </p>
                    }>
                    <AgentSettings
                        environment={environment()}
                        harness={chosenHarness()}
                        setHarness={setHarness}
                        model={model()}
                        setModel={setModel}
                        mode="print"
                        setMode={() => {}}
                        permission={permission()}
                        setPermission={setPermission}
                        unattended
                        perTaskModel={false}
                    />
                </Loading>
                <label class="field mt-4">
                    <span>Instructions for the agent</span>
                    <textarea
                        value={extra()}
                        onInput={(event) => setExtra(event.currentTarget.value)}
                        placeholder="Optional: how you would want decisions and blockers handled…"
                    />
                </label>
            </section>

            <Stage
                number={1}
                title="Investigations"
                hint="Each one files tasks on the work package's newest branch.">
                <InvestigationList
                    workPackage={props.workPackage}
                    selected={investigations()}
                    toggle={(ref, on) =>
                        setInvestigations((set) => toggle(set, ref, on))
                    }
                    added={(ref) => {
                        setInvestigations((set) => toggle(set, ref, true))
                        props.changed()
                    }}
                />
            </Stage>

            <Stage
                number={2}
                title="Task Run"
                hint="A fresh headless agent per task, in dependency order, with the agent above as supervisor.">
                <label class="choice flex items-center gap-[0.75rem] p-[0.7rem]">
                    <input
                        type="checkbox"
                        checked={working()}
                        onChange={(event) =>
                            setWorking(event.currentTarget.checked)
                        }
                    />
                    <span class="min-w-0 flex-1">Work tasks</span>
                    <span class="caption muted">
                        {props.workPackage.queue.length} open now
                    </span>
                </label>
                <Show when={working()}>
                    <div class="mt-3">
                        <fieldset class="m-0 grid gap-2 border-0 p-0">
                            <legend class="caption mb-2">Tasks to work</legend>
                            <label class="choice flex items-start gap-3 p-[0.7rem]">
                                <input
                                    type="radio"
                                    name="pipeline-task-mode"
                                    checked={taskMode() === "all"}
                                    onChange={() => setTaskMode("all")}
                                />
                                <span>
                                    <span class="block">All open tasks</span>
                                    <span class="caption muted">
                                        Works all open tasks, including those
                                        filed by investigations and any added
                                        while the task stage is running.
                                    </span>
                                </span>
                            </label>
                            <label class="choice flex items-start gap-3 p-[0.7rem]">
                                <input
                                    type="radio"
                                    name="pipeline-task-mode"
                                    checked={taskMode() === "selected"}
                                    onChange={() => setTaskMode("selected")}
                                />
                                <span>
                                    <span class="block">Selected tasks</span>
                                    <span class="caption muted">
                                        Only the tasks you select below. Newly
                                        added tasks, including those filed by
                                        investigations, are left for another
                                        run.
                                    </span>
                                </span>
                            </label>
                        </fieldset>
                        <Show when={taskMode() === "selected"}>
                            <div class="mt-3 mb-2 flex items-center justify-between gap-2">
                                <span class="caption muted" aria-live="polite">
                                    {selectedTasks().length} of{" "}
                                    {props.workPackage.queue.length} open tasks
                                    selected
                                </span>
                                <div class="flex gap-2">
                                    <button
                                        class="outlined"
                                        onClick={() =>
                                            setTaskSelection(
                                                new Set(
                                                    props.workPackage.queue.map(
                                                        (task) => task.ref,
                                                    ),
                                                ),
                                            )
                                        }>
                                        Select all
                                    </button>
                                    <button
                                        class="outlined"
                                        onClick={() =>
                                            setTaskSelection(new Set())
                                        }>
                                        Clear
                                    </button>
                                </div>
                            </div>
                            <div class="grid max-h-64 gap-2 overflow-y-auto">
                                <For
                                    each={props.workPackage.queue}
                                    fallback={
                                        <p class="hint m-0">
                                            No open tasks yet.
                                        </p>
                                    }>
                                    {(task) => (
                                        <label class="choice flex items-center gap-[0.75rem] p-[0.7rem]">
                                            <input
                                                type="checkbox"
                                                checked={taskSelection().has(
                                                    task.ref,
                                                )}
                                                onChange={(event) =>
                                                    setTaskSelection((set) =>
                                                        toggle(
                                                            set,
                                                            task.ref,
                                                            event.currentTarget
                                                                .checked,
                                                        ),
                                                    )
                                                }
                                            />
                                            <span class="font-mono caption muted">
                                                {task.ref}
                                            </span>
                                            <span class="min-w-0 flex-1">
                                                <span
                                                    class="block truncate"
                                                    title={task.title}>
                                                    {task.title}
                                                </span>
                                                <Show
                                                    when={
                                                        task.dependsOn.length >
                                                        0
                                                    }>
                                                    <span class="caption muted">
                                                        Depends on{" "}
                                                        {task.dependsOn.join(
                                                            ", ",
                                                        )}
                                                    </span>
                                                </Show>
                                            </span>
                                            <span class="badge p-[0.12rem_0.42rem]">
                                                {STATUS_LABELS[task.status]}
                                            </span>
                                        </label>
                                    )}
                                </For>
                            </div>
                            <p class="caption muted mt-2">
                                A selected task waits if an unfinished
                                dependency is left out.
                            </p>
                            <Show when={!selectedTasks().length}>
                                <p class="hint">
                                    Select at least one task to include the task
                                    stage.
                                </p>
                            </Show>
                        </Show>
                        <div class="mt-3">
                            <Loading
                                fallback={
                                    <ModelPicker
                                        harness={chosenHarness()}
                                        models={[]}
                                        value=""
                                        setValue={() => {}}
                                        defaultLabel="Harness default"
                                        recommended
                                        busy
                                    />
                                }>
                                <ModelPicker
                                    harness={chosenHarness()}
                                    models={isPending(models) ? [] : models()}
                                    busy={isPending(models)}
                                    value={taskModel()}
                                    setValue={setTaskModel}
                                    defaultLabel="Harness default"
                                    recommended
                                />
                            </Loading>
                            <label class="field mt-3">
                                <span>Instructions for task agents</span>
                                <textarea
                                    value={taskExtra()}
                                    onInput={(event) =>
                                        setTaskExtra(event.currentTarget.value)
                                    }
                                    placeholder="Optional context for every task…"
                                />
                            </label>
                        </div>
                    </div>
                </Show>
            </Stage>

            <Stage
                number={3}
                title="Branches"
                hint={`Each is taken through: ${BRANCH_STEPS.map((step) => BRANCH_STEP_LABELS[step]).join(" → ")}.`}>
                <BranchList
                    workPackage={props.workPackage}
                    snapshot={props.snapshot}
                    selected={branches()}
                    toggle={(id, on) =>
                        setBranches((set) => toggle(set, id, on))
                    }
                    added={(id) => {
                        setBranches((set) => toggle(set, id, true))
                        props.changed()
                    }}
                />
            </Stage>

            <label class="field mt-5">
                <span>
                    Tab name <small class="optional">(optional)</small>
                </span>
                <input
                    value={label()}
                    onInput={(event) => setLabel(event.currentTarget.value)}
                    placeholder="Start to finish"
                />
            </label>

            <Banner />
            <div class="mt-5 flex justify-end">
                <button
                    class="primary"
                    aria-busy={busy() === "start" ? "true" : "false"}
                    disabled={!!busy() || isPending(harness) || nothingChosen()}
                    onClick={start}>
                    Start run
                </button>
            </div>
        </Modal>
    )
}

function Stage(props: {
    number: number
    title: string
    hint: string
    children: Element
}) {
    return (
        <section class="mt-5 border-t border-slate-200 pt-5">
            <h3 class="m-0">
                {props.number}. {props.title}
            </h3>
            <p class="caption muted m-[0.25rem_0_0.75rem]">{props.hint}</p>
            {props.children}
        </section>
    )
}

function InvestigationList(props: {
    workPackage: WorkPackageDetail
    selected: ReadonlySet<string>
    toggle: (ref: string, on: boolean) => void
    added: (ref: string) => void
}) {
    const [adding, setAdding] = createSignal(false)
    const [title, setTitle] = createSignal("")
    const [brief, setBrief] = createSignal("")
    const [busy, setBusy] = createOptimistic(false)
    const { capture, clear, Banner } = useError()

    const add = action(async function* () {
        if (busy() || !brief().trim()) return
        setBusy(true)
        clear()
        try {
            const result = await api.addWorkPackageInvestigation(
                props.workPackage.ref,
                { title: title().trim() || undefined, brief: brief() },
            )
            yield
            props.added(result.investigation.ref)
            setAdding(false)
            setTitle("")
            setBrief("")
        } catch (caught) {
            yield
            capture(caught)
        }
    })

    return (
        <>
            <div class="grid gap-2">
                <For
                    each={props.workPackage.investigations}
                    fallback={
                        <p class="hint m-0">This work package has none yet.</p>
                    }>
                    {(item) => (
                        <label class="choice flex items-center gap-[0.75rem] p-[0.7rem]">
                            <input
                                type="checkbox"
                                checked={props.selected.has(item.ref)}
                                onChange={(event) =>
                                    props.toggle(
                                        item.ref,
                                        event.currentTarget.checked,
                                    )
                                }
                            />
                            <span class="font-mono caption muted">
                                {item.ref}
                            </span>
                            <span class="min-w-0 flex-1 truncate">
                                {item.title}
                            </span>
                            <span class="badge p-[0.12rem_0.42rem]">
                                {INVESTIGATION_STATUS_LABELS[item.status]}
                            </span>
                        </label>
                    )}
                </For>
            </div>
            <Show
                when={adding()}
                fallback={
                    <button
                        class="outlined mt-3"
                        onClick={() => setAdding(true)}>
                        <PlusIcon />
                        Add investigation
                    </button>
                }>
                <article class="inset mt-3 p-4">
                    <label class="field">
                        <span>
                            Title <small class="optional">(optional)</small>
                        </span>
                        <input
                            value={title()}
                            onInput={(event) =>
                                setTitle(event.currentTarget.value)
                            }
                            placeholder={props.workPackage.name}
                        />
                    </label>
                    <label class="field mt-3">
                        <span>Brief</span>
                        <textarea
                            value={brief()}
                            onInput={(event) =>
                                setBrief(event.currentTarget.value)
                            }
                            placeholder="What should the agent find out?"
                        />
                    </label>
                    <Banner />
                    <div class="mt-3 flex justify-end gap-2">
                        <button
                            class="outlined"
                            onClick={() => setAdding(false)}>
                            Cancel
                        </button>
                        <button
                            class="primary"
                            aria-busy={busy() ? "true" : "false"}
                            disabled={busy() || !brief().trim()}
                            onClick={add}>
                            Add investigation
                        </button>
                    </div>
                </article>
            </Show>
        </>
    )
}

function BranchList(props: {
    workPackage: WorkPackageDetail
    snapshot: WorkspaceSnapshot
    selected: ReadonlySet<number>
    toggle: (id: number, on: boolean) => void
    added: (id: number) => void
}) {
    // With no branch to deliver through, the form is the obvious next step.
    const [adding, setAdding] = createSignal(
        untrack(() => !props.workPackage.branches.length),
    )
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
    const problem = () =>
        branchDraftProblem(draft(), props.snapshot.localBranches, claimed())

    const add = action(async function* () {
        if (busy() || problem()) return
        setBusy(true)
        clear()
        try {
            const result = await api.addWorkPackageBranch(
                props.workPackage.ref,
                toNewBranchInput(draft()),
            )
            yield
            props.added(result.branch.id)
            setAdding(false)
            setDraft(emptyBranchDraft())
        } catch (caught) {
            yield
            capture(caught)
        }
    })

    return (
        <>
            <div class="grid gap-2">
                <For
                    each={props.workPackage.branches}
                    fallback={
                        <p class="hint m-0">
                            This work package has no branch yet. Add one for the
                            tasks to land on.
                        </p>
                    }>
                    {(branch) => (
                        <label class="choice flex items-center gap-[0.75rem] p-[0.7rem]">
                            <input
                                type="checkbox"
                                checked={props.selected.has(branch.id)}
                                disabled={!!branch.delivery?.prUrl}
                                onChange={(event) =>
                                    props.toggle(
                                        branch.id,
                                        event.currentTarget.checked,
                                    )
                                }
                            />
                            <span class="min-w-0 flex-1">
                                <strong class="block truncate">
                                    {branch.label}
                                </strong>
                                <span class="block font-mono caption muted truncate">
                                    {branch.branchName} → {branch.base}
                                </span>
                            </span>
                            <Show when={branch.delivery?.prUrl}>
                                <span class="badge success p-[0.12rem_0.42rem]">
                                    PR open
                                </span>
                            </Show>
                        </label>
                    )}
                </For>
            </div>
            <Show
                when={adding()}
                fallback={
                    <button
                        class="outlined mt-3"
                        onClick={() => setAdding(true)}>
                        <PlusIcon />
                        Add branch
                    </button>
                }>
                <article class="inset mt-3 p-4">
                    <BranchFields
                        id="pipeline-branch"
                        draft={draft()}
                        change={setDraft}
                        localBranches={props.snapshot.localBranches}
                        currentBranch={props.snapshot.currentBranch}
                        claimed={claimed()}
                        baseBranch={props.workPackage.baseBranch}
                    />
                    <Banner />
                    <div class="mt-3 flex justify-end gap-2">
                        <Show when={props.workPackage.branches.length}>
                            <button
                                class="outlined"
                                onClick={() => setAdding(false)}>
                                Cancel
                            </button>
                        </Show>
                        <button
                            class="primary"
                            aria-busy={busy() ? "true" : "false"}
                            disabled={busy() || !!problem()}
                            onClick={add}>
                            Add branch
                        </button>
                    </div>
                </article>
            </Show>
        </>
    )
}
