import {
    action,
    createOptimistic,
    Loading,
    isPending,
    Show,
    createEffect,
    createMemo,
    createSignal,
    refresh,
} from "solid-js"
import {
    MAX_SUPERVISIONS_PER_TASK,
    RECOMMENDED_MODEL,
    nextWorkableTask,
    type AgentHarnessId,
    type AgentPermissionMode,
    type AgentRunMode,
    type AgentRun,
    type Task,
    type WorkPackageDetail,
} from "@work-task-manager/shared"
import { api } from "../api"
import { useError } from "../hooks/useError"
import { AgentSettings } from "../components/AgentSettings"
import { SupervisorFields } from "../components/SupervisorFields"
import { RunHistory } from "../components/RunHistory"
import { Modal } from "../components/Modal"

export function AgentLauncher(props: {
    workPackage: WorkPackageDetail
    task?: Task
    close: () => void
    finished: () => void
    /** Told the id of the Run tab a work package run was recorded as. */
    started?: (workRunId: number) => void
}) {
    type RunChoice = "task" | "guided-work-package" | "unattended"
    const initial: RunChoice = props.task ? "task" : "guided-work-package"
    const [choice, setChoice] = createSignal<RunChoice>(initial)
    const environment = createMemo(() => api.agentEnvironment())
    const [harness, setHarness] = createSignal("")
    const [model, setModel] = createSignal("")
    const [mode, setMode] = createSignal<AgentRunMode>("terminal")
    const [permission, setPermission] =
        createSignal<AgentPermissionMode>("manual")
    const [extra, setExtra] = createSignal("")
    const [label, setLabel] = createSignal("")
    // The supervisor an unattended run calls in when a task stops short.
    const [supervised, setSupervised] = createSignal(false)
    const [fallback, setFallback] = createSignal<"stop" | "codex">("stop")
    const [supervisorHarness, setSupervisorHarness] = createSignal("")
    const [supervisorModel, setSupervisorModel] = createSignal("")
    const [supervisorPermission, setSupervisorPermission] =
        createSignal<AgentPermissionMode>("bypassPermissions")
    const [supervisorExtra, setSupervisorExtra] = createSignal("")
    const [busy, setBusy] = createOptimistic(false)
    const { capture, clear, Banner } = useError()
    // Task pages are the place a person returns after an agent has stopped. Keep
    // the history scoped to this task, rather than mixing in unrelated work package runs.
    const history = createMemo(async (): Promise<AgentRun[]> =>
        props.task
            ? api.listAgentRuns({ kind: "task", ref: props.task.ref })
            : [],
    )

    const chosenHarness = () =>
        harness() ||
        environment().harnesses.find(
            (item) => item.id === "codex" && item.available,
        )?.id ||
        environment().harnesses.find((item) => item.available)?.id ||
        ""

    // Do not give a select a value it cannot render. The previous Codex default
    // made the browser show its first option (often Claude) while fetching Codex
    // models, leaving the two controls out of sync.
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
                    (item) => item.id === "codex" && item.available,
                )?.id ??
                    env.harnesses.find((item) => item.available)?.id ??
                    "",
            )
        },
    )

    // Until one is picked, the supervisor is the same agent as the tasks'.
    const chosenSupervisorHarness = () => supervisorHarness() || chosenHarness()

    const next = () => props.task ?? nextWorkableTask(props.workPackage)
    const run = action(async function* () {
        if (busy() || isPending(harness)) return

        setBusy(true)
        clear()
        try {
            const selectedHarness = chosenHarness()
            if (!selectedHarness)
                throw new Error("No supported agent harness is installed.")
            const launchMode =
                mode() === "terminal" && !environment().terminalAvailable
                    ? "print"
                    : mode()
            // The special per-task choice belongs only to the unattended
            // loop. A person can switch run types after choosing it.
            const selectedModel =
                choice() === "unattended"
                    ? model()
                    : model() === RECOMMENDED_MODEL
                      ? ""
                      : model()
            if (!props.task) {
                // From the work package: every run becomes a Run tab.
                const result = await api.startWorkRun(props.workPackage.ref, {
                    kind:
                        choice() === "unattended"
                            ? "unattended"
                            : choice() === "guided-work-package"
                              ? "guided"
                              : "next-task",
                    label: label().trim() || undefined,
                    harness: selectedHarness,
                    model: selectedModel,
                    mode: launchMode,
                    permissionMode: permission(),
                    extra: extra(),
                    fallback: choice() === "unattended" ? fallback() : "stop",
                    supervisor:
                        choice() === "unattended" && supervised()
                            ? {
                                  harness:
                                      chosenSupervisorHarness() as AgentHarnessId,
                                  model: supervisorModel(),
                                  permissionMode: supervisorPermission(),
                                  extra: supervisorExtra(),
                              }
                            : null,
                })
                yield
                props.finished()
                props.started?.(result.workRun.id)
                props.close()
                return
            }
            const task = next()
            if (!task) throw new Error("There is no task ready to work.")
            await api.startAgentRun({
                harness: selectedHarness,
                model: selectedModel,
                mode: launchMode,
                command: "work-task",
                target: task.ref,
                extra: extra(),
                subjectKind: "task",
                subjectRef: task.ref,
                permissionMode: permission(),
            })
            yield
            refresh(history)
            props.finished()
            props.close()
        } catch (caught) {
            yield
            capture(caught)
        }
    })

    return (
        <Modal
            title={props.task ? "Work with an agent" : "Start a run"}
            close={props.close}>
            <Show when={!props.task}>
                <p class="description m-[0_0_1rem]">
                    The run gets a tab of its own, listing the tasks it works
                    through.
                </p>
            </Show>
            <div class="grid gap-3 sm:grid-cols-3">
                <RunChoice
                    selected={choice() === "task"}
                    title={
                        props.task ? `Work ${props.task.ref}` : "Work next task"
                    }
                    detail="One task, then stop for review."
                    onClick={() => setChoice("task")}
                />
                <RunChoice
                    selected={choice() === "guided-work-package"}
                    title="Guided work package run"
                    detail="One agent works the whole work package."
                    onClick={() => setChoice("guided-work-package")}
                />
                <RunChoice
                    selected={choice() === "unattended"}
                    title="Unattended work package"
                    detail="A fresh headless agent per task."
                    onClick={() => setChoice("unattended")}
                />
            </div>

            <Loading
                fallback={
                    <p class="mt-5 description">Checking installed agents…</p>
                }>
                <AgentSettings
                    environment={environment()}
                    harness={chosenHarness()}
                    setHarness={setHarness}
                    model={model()}
                    setModel={setModel}
                    mode={mode()}
                    setMode={setMode}
                    permission={permission()}
                    setPermission={setPermission}
                    unattended={choice() === "unattended"}
                    // An unattended run has an explicit per-task recommended
                    // option, rather than silently taking its first task's model.
                    recommendedTier={
                        choice() === "unattended"
                            ? null
                            : next()?.recommendedTier
                    }
                />
            </Loading>

            <Show when={!props.task}>
                <label class="field mt-4">
                    <span>
                        Tab name <small class="optional">(optional)</small>
                    </span>
                    <input
                        value={label()}
                        onInput={(event) => setLabel(event.currentTarget.value)}
                        placeholder="Named after the kind of run"
                    />
                </label>
            </Show>
            <label class="field mt-4">
                <span>Extra instructions</span>
                <textarea
                    value={extra()}
                    onInput={(event) => setExtra(event.currentTarget.value)}
                    placeholder="Optional context for the agent…"
                />
            </label>
            <Show when={choice() === "unattended"}>
                <details class="mt-5 border-t border-slate-200 pt-5">
                    <summary class="cursor-pointer font-semibold">
                        Fallback
                    </summary>
                    <p class="caption muted mt-2">
                        When Claude reaches a usage limit, choose how this task
                        run continues.
                    </p>
                    <label class="field mt-3">
                        <span>When Claude usage runs out</span>
                        <select
                            value={fallback()}
                            onChange={(event) =>
                                setFallback(
                                    event.currentTarget.value as
                                        "stop" | "codex",
                                )
                            }>
                            <option value="stop">Stop and wait for me</option>
                            <option value="codex">Continue with Codex</option>
                        </select>
                    </label>
                    <p class="caption muted mt-2">
                        Codex starts a new conversation with the interrupted
                        task's handoff and works the remaining tasks. A Claude
                        supervisor also switches to Codex.
                    </p>
                </details>
                <section class="mt-5 border-t border-slate-200 pt-5">
                    <label class="choice flex items-start gap-[0.75rem] p-[0.85rem]">
                        <input
                            type="checkbox"
                            class="w-[1rem] h-[1rem] mt-[0.12rem]"
                            checked={supervised()}
                            onChange={(event) =>
                                setSupervised(event.currentTarget.checked)
                            }
                        />
                        <span class="grid gap-[0.22rem]">
                            <strong>Add a supervisor</strong>
                            <small>
                                When a task stops short of Dev Complete, a
                                supervisor agent steps in for you. It makes the
                                call the task's agent stopped to ask about, or
                                fixes what broke, and then the run carries on.
                                It is called in at most{" "}
                                {MAX_SUPERVISIONS_PER_TASK} times per task.
                            </small>
                        </span>
                    </label>
                    <Show when={supervised()}>
                        <Loading fallback={null}>
                            <SupervisorFields
                                environment={environment()}
                                harness={chosenSupervisorHarness()}
                                setHarness={setSupervisorHarness}
                                model={supervisorModel()}
                                setModel={setSupervisorModel}
                                permission={supervisorPermission()}
                                setPermission={setSupervisorPermission}
                                extra={supervisorExtra()}
                                setExtra={setSupervisorExtra}
                            />
                        </Loading>
                    </Show>
                </section>
            </Show>
            <Loading fallback={null}>
                <Show when={props.task && history().length}>
                    <section class="mt-5 border-t border-slate-200 pt-5">
                        <h3 class="text-sm font-semibold text-slate-800">
                            Earlier runs
                        </h3>
                        <p class="mt-1 caption muted">
                            Reopen an agent conversation that previously worked
                            on this task.
                        </p>
                        <div class="mt-3">
                            <RunHistory runs={history()} />
                        </div>
                    </section>
                </Show>
            </Loading>
            <Banner />
            <div class="mt-5 flex justify-end">
                <button
                    aria-busy={busy() ? "true" : "false"}
                    class="primary"
                    disabled={busy() || isPending(harness)}
                    onClick={run}>
                    Start run
                </button>
            </div>
        </Modal>
    )
}

function RunChoice(props: {
    selected: boolean
    title: string
    detail: string
    onClick: () => void
}) {
    return (
        <button
            class="card-item p-4"
            aria-pressed={props.selected ? "true" : "false"}
            onClick={props.onClick}>
            <strong class="block text-sm">{props.title}</strong>
            <span class="mt-1 block caption muted">{props.detail}</span>
        </button>
    )
}
