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
} from "solid-js"
import {
    nextWorkableTask,
    type AgentPermissionMode,
    type AgentRunMode,
    type AgentRun,
    type Task,
    type WorkPackageDetail,
} from "@shared/types"
import { api } from "../api"
import { AgentSettings } from "../components/AgentSettings"
import { Modal } from "../components/Modal"

export function AgentLauncher(props: {
    workPackage: WorkPackageDetail
    task?: Task
    close: () => void
    finished: () => void
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
    const [busy, setBusy] = createOptimistic(false)
    const [resuming, setResuming] = createOptimistic<number | null>(null)
    const [error, setError] = createSignal("")
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

    const next = () => props.task ?? nextWorkableTask(props.workPackage)
    const resume = action(function* (entry: AgentRun) {
        if (resuming() !== null || busy()) return

        if (!entry.sessionId) return
        setResuming(entry.id)
        setError("")
        try {
            yield api.resumeAgentRun(entry.id)
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught))
        }
    })
    const run = action(function* () {
        if (busy()) return

        setBusy(true)
        setError("")
        try {
            const selectedHarness = chosenHarness()
            if (!selectedHarness)
                throw new Error("No supported agent harness is installed.")
            if (choice() === "unattended") {
                yield api.startWorkPackageRun(props.workPackage.ref, {
                    harness: selectedHarness,
                    model: model(),
                    permissionMode:
                        permission() === "manual"
                            ? "bypassPermissions"
                            : permission(),
                    extra: extra(),
                    excluded: [],
                })
            } else {
                const task = next()
                const target =
                    choice() === "task" ? task?.ref : props.workPackage.ref
                if (!target) throw new Error("There is no task ready to work.")
                yield api.startAgentRun({
                    harness: selectedHarness,
                    model: model(),
                    mode:
                        mode() === "terminal" &&
                        !environment().terminalAvailable
                            ? "print"
                            : mode(),
                    command: choice() === "task" ? "work-task" : "work-package",
                    target,
                    extra: extra(),
                    subjectKind: choice() === "task" ? "task" : "work-package",
                    subjectRef:
                        choice() === "task" ? target : props.workPackage.ref,
                    permissionMode: permission(),
                })
            }
            yield refresh(history)
            props.finished()
            props.close()
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught))
        }
    })

    return (
        <Modal title="Work with an agent" close={props.close}>
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
                }
            >
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
                    recommendedTier={next()?.recommendedTier}
                />
            </Loading>

            <label class="field mt-4">
                <span>Extra instructions</span>
                <textarea
                    value={extra()}
                    onInput={(event) => setExtra(event.currentTarget.value)}
                    placeholder="Optional context for the agent…"
                />
            </label>
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
                        <ul class="mt-3 space-y-2">
                            <For each={history()}>
                                {(entry) => (
                                    <li class="flex flex-wrap items-center gap-2 tonal px-3 py-2 text-xs">
                                        <span class="font-medium capitalize text-slate-700">
                                            {entry.status}
                                        </span>
                                        <span class="font-mono text-slate-500">
                                            {entry.harness}
                                            {entry.model
                                                ? ` · ${entry.model}`
                                                : ""}
                                        </span>
                                        <span class="text-slate-400">
                                            {entry.mode === "print"
                                                ? "Headless"
                                                : "Terminal"}
                                        </span>
                                        <time class="ml-auto text-slate-400">
                                            {new Date(
                                                entry.createdAt,
                                            ).toLocaleString()}
                                        </time>
                                        <button
                                            aria-busy={
                                                resuming() === entry.id
                                                    ? "true"
                                                    : "false"
                                            }
                                            class="outlined px-2 py-1 text-xs"
                                            disabled={
                                                !entry.sessionId ||
                                                resuming() !== null
                                            }
                                            title={
                                                entry.sessionId
                                                    ? `Reopen this ${entry.harness} conversation in a terminal`
                                                    : "This run has no recorded conversation ID. Interactive Codex runs cannot be reopened here."
                                            }
                                            onClick={() => resume(entry)}
                                        >
                                            Resume
                                        </button>
                                    </li>
                                )}
                            </For>
                        </ul>
                    </section>
                </Show>
            </Loading>
            <Show when={error()}>
                <p class="notice error mt-4">{error()}</p>
            </Show>
            <div class="mt-5 flex justify-end">
                <button
                    aria-busy={busy() ? "true" : "false"}
                    class="primary"
                    disabled={busy()}
                    onClick={run}
                >
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
            onClick={props.onClick}
        >
            <strong class="block text-sm">{props.title}</strong>
            <span class="mt-1 block caption muted">{props.detail}</span>
        </button>
    )
}
