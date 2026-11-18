import {
    BRANCH_STEP_LABELS,
    RECOMMENDED_MODEL,
    WORK_RUN_KIND_LABELS,
    type PipelineStepDetail,
    type PipelineStepState,
    type WorkPackageDetail,
    type WorkRunAgent,
    type WorkRunDetail,
    type WorkRunItem,
    type WorkRunStatus,
} from "@shared/types"
import { action, createOptimistic, createSignal, For, Show } from "solid-js"
import { api } from "../api"
import { AgentOutput } from "../components/AgentOutput"
import { StatusBadge } from "../components/StatusBadge"
import { SupervisorRow } from "../components/SupervisorRow"
import { useError } from "../hooks/useError"
import { TabHeading } from "./TabHeading"

const STATUS_LABELS: Record<WorkRunStatus, string> = {
    launched: "Opened in a terminal",
    running: "Running",
    finished: "Finished",
    stopped: "Stopped",
    blocked: "Needs attention",
    failed: "Failed",
}

const STATUS_TONES: Record<WorkRunStatus, string> = {
    launched: "info",
    running: "accent",
    finished: "success",
    stopped: "",
    blocked: "warning",
    failed: "error",
}

const ITEM_LABELS = {
    done: "Worked",
    working: "Working",
    waiting: "To work",
} as const

/**
 * One Run tab: what kind of run it is, how it is going, and the tasks it is
 * working through.
 */
export function RunPanel(props: {
    workPackage: WorkPackageDetail
    run: WorkRunDetail
    openTask: (ref: string) => void
    changed: () => void
    /** Open the dialog that attaches, changes or removes the supervisor. */
    editSupervisor: (run: WorkRunDetail) => void
    resumePipeline: (run: WorkRunDetail) => void
}) {
    const [busy, setBusy] = createOptimistic("")
    const { capture, clear, Banner } = useError()
    const running = () => props.run.status === "running"
    const agent = () => props.run.agentRun
    // An unattended loop that has settled any way but finishing can carry on
    // from where it got to.
    const resumable = () =>
        (props.run.kind === "unattended" || props.run.kind === "pipeline") &&
        (props.run.status === "stopped" ||
            props.run.status === "blocked" ||
            props.run.status === "failed")

    const act = action(function* (
        label: string,
        request: () => Promise<unknown>,
    ) {
        if (busy()) return
        setBusy(label)
        clear()
        try {
            yield request()
            props.changed()
        } catch (caught) {
            capture(caught)
        }
    })

    const done = () =>
        props.run.items.filter((item) => item.state === "done").length

    return (
        <section class="mx-auto grid max-w-4xl grid-cols-1 gap-[1.1rem]">
            <TabHeading
                title={props.run.label}
                description={WORK_RUN_KIND_LABELS[props.run.kind]}
                rename={(label) =>
                    api.renameWorkRun(
                        props.workPackage.ref,
                        props.run.id,
                        label,
                    )
                }
                remove={
                    running()
                        ? undefined
                        : {
                              label: "Remove",
                              confirm: `Remove the '${props.run.label}' tab? The tasks it worked stay as they are.`,
                              run: () =>
                                  api.removeWorkRun(
                                      props.workPackage.ref,
                                      props.run.id,
                                  ),
                          }
                }
                changed={props.changed}>
                <span
                    class={`badge ${STATUS_TONES[props.run.status]} p-[0.3rem_0.7rem]`}
                    aria-busy={running() ? "true" : "false"}>
                    {STATUS_LABELS[props.run.status]}
                </span>
            </TabHeading>

            <Banner />
            <Show when={props.run.statusDetail}>
                <p class="notice warning m-0">{props.run.statusDetail}</p>
            </Show>

            <article class="tonal p-5">
                <dl class="m-0 grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-4 [&_dt]:text-xs [&_dt]:text-slate-400 [&_dd]:m-0 [&_dd]:text-sm">
                    <div>
                        <dt>Kind</dt>
                        <dd>{WORK_RUN_KIND_LABELS[props.run.kind]}</dd>
                    </div>
                    <div>
                        <dt>Agent</dt>
                        <dd class="font-mono">
                            {props.run.harness}
                            {props.run.model === RECOMMENDED_MODEL
                                ? " · recommended per task"
                                : props.run.model
                                  ? ` · ${props.run.model}`
                                  : ""}
                        </dd>
                    </div>
                    <div>
                        <dt>Launched</dt>
                        <dd>
                            {props.run.mode === "print"
                                ? "Headless"
                                : "In a terminal"}
                        </dd>
                    </div>
                    <div>
                        <dt>Started</dt>
                        <dd>
                            {new Date(props.run.createdAt).toLocaleString()}
                        </dd>
                    </div>
                </dl>
                <Show when={props.run.extra}>
                    <p class="hint mt-3 mb-0 whitespace-pre-wrap">
                        {props.run.extra}
                    </p>
                </Show>
                <Show when={props.run.pipeline && props.run.supervisor}>
                    {(agent) => (
                        <p class="caption muted mt-3 mb-0">
                            It investigates, and supervises the task runs, the
                            rebase and the checks:{" "}
                            <span class="font-mono">
                                {agent().harness}
                                {agent().model ? ` · ${agent().model}` : ""}
                            </span>
                        </p>
                    )}
                </Show>
                <Show when={props.run.kind === "unattended"}>
                    <div class="mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                        <p class="caption muted m-0 min-w-0 flex-1">
                            <Show
                                when={props.run.supervisor}
                                fallback="No supervisor: a task that stops short stops the run.">
                                {(supervisor) => (
                                    <>
                                        Supervisor:{" "}
                                        <span class="font-mono">
                                            {supervisor().harness}
                                            {supervisor().model
                                                ? ` · ${supervisor().model}`
                                                : ""}
                                        </span>
                                        , called in when a task stops short.
                                        <Show when={supervisor().extra}>
                                            <span class="mt-1 block whitespace-pre-wrap">
                                                {supervisor().extra}
                                            </span>
                                        </Show>
                                    </>
                                )}
                            </Show>
                        </p>
                        <button
                            class="outlined p-[0.2rem_0.6rem] caption"
                            onClick={() => props.editSupervisor(props.run)}>
                            {props.run.supervisor
                                ? "Change supervisor"
                                : "Add a supervisor"}
                        </button>
                    </div>
                </Show>
                <div class="mt-4 flex flex-wrap gap-2">
                    <Show when={running()}>
                        <button
                            class="outlined"
                            aria-busy={busy() === "stop" ? "true" : "false"}
                            disabled={!!busy()}
                            onClick={() =>
                                act("stop", () =>
                                    api.stopWorkRun(
                                        props.workPackage.ref,
                                        props.run.id,
                                    ),
                                )
                            }>
                            Stop
                        </button>
                    </Show>
                    <Show when={resumable()}>
                        <button
                            class="primary"
                            aria-busy={busy() === "resume" ? "true" : "false"}
                            disabled={!!busy()}
                            title={
                                props.run.kind === "pipeline"
                                    ? "Review agent settings and resume from the stage it stopped on."
                                    : "Start the loop again. The task it stopped on goes to a fresh agent, handed the task and what the last agent left behind."
                            }
                            onClick={() => {
                                if (props.run.kind === "pipeline") {
                                    props.resumePipeline(props.run)
                                    return
                                }
                                void act("resume", () =>
                                    api.resumeWorkRun(
                                        props.workPackage.ref,
                                        props.run.id,
                                    ),
                                )
                            }}>
                            Resume run
                        </button>
                    </Show>
                    <Show when={agent()}>
                        {(current) => (
                            <button
                                class="outlined"
                                aria-busy={
                                    busy() === "reopen" ? "true" : "false"
                                }
                                disabled={!!busy() || !current().sessionId}
                                title={
                                    current().sessionId
                                        ? `Reopen this ${current().harness} conversation in a terminal`
                                        : "This run has no recorded conversation ID to reopen."
                                }
                                onClick={() =>
                                    act("reopen", () =>
                                        api.resumeAgentRun(current().id),
                                    )
                                }>
                                Resume in a terminal
                            </button>
                        )}
                    </Show>
                </div>
            </article>

            <Show when={props.run.pipeline}>
                {(pipeline) => (
                    <article class="elevated p-5">
                        <header class="flex items-baseline justify-between gap-3">
                            <h3 class="m-0">Stages</h3>
                            <span class="caption muted">
                                {
                                    pipeline().steps.filter(
                                        (step) =>
                                            step.state === "done" ||
                                            step.state === "skipped",
                                    ).length
                                }{" "}
                                of {pipeline().steps.length} done
                            </span>
                        </header>
                        <ol
                            class="mt-4 grid grid-cols-1 gap-1 p-0"
                            style={{ "list-style": "none" }}>
                            <For each={pipeline().steps}>
                                {(step, index) => (
                                    <PipelineStepRow
                                        runId={props.run.id}
                                        step={step}
                                        index={index()}
                                        running={running()}
                                    />
                                )}
                            </For>
                        </ol>
                    </article>
                )}
            </Show>

            <article class="elevated p-5">
                <header class="flex items-baseline justify-between gap-3">
                    <h3 class="m-0">Tasks</h3>
                    <span class="caption muted">
                        {done()} of {props.run.items.length} worked
                    </span>
                </header>
                <ol
                    class="mt-4 grid grid-cols-1 gap-1 p-0"
                    style={{ "list-style": "none" }}>
                    <For
                        each={props.run.items}
                        fallback={
                            <li class="hint">
                                {props.run.kind === "pipeline"
                                    ? "Tasks join this list as each task run starts."
                                    : "This run had no tasks to work."}
                            </li>
                        }>
                        {(item, index) => (
                            <RunItem
                                runId={props.run.id}
                                item={item}
                                index={index()}
                                running={running()}
                                openTask={props.openTask}
                            />
                        )}
                    </For>
                </ol>
            </article>
        </section>
    )
}

/*
 * Keep expansion and cached output across tab switches and page navigation.
 * Background refreshes reconcile the run in place and retain its mounted UI.
 */
const [expanded, setExpanded] = createSignal<ReadonlySet<string>>(new Set())

/** A task in the run, with the output of the agents that worked it folded
 *  away underneath, and a row under it for each time a supervisor was called
 *  in on it. */
function RunItem(props: {
    runId: number
    item: WorkRunItem
    index: number
    running: boolean
    openTask: (ref: string) => void
}) {
    const key = () => `${props.runId}:${props.item.ref.toLowerCase()}`
    const open = () => expanded().has(key())
    const setOpen = (value: boolean) =>
        setExpanded((current) => {
            const next = new Set(current)
            if (value) next.add(key())
            else next.delete(key())
            return next
        })
    const isSupervisor = (agent: WorkRunAgent) =>
        agent.command === "supervise-task"
    const workers = () =>
        props.item.agents.filter((agent) => !isSupervisor(agent))
    const supervisors = () => props.item.agents.filter(isSupervisor)
    const hasOutput = () => workers().length > 0
    const unblocking = () => {
        const last = props.item.agents.at(-1)
        return (
            props.running &&
            last?.command === "supervise-task" &&
            last.status === "running"
        )
    }
    // Numbered among the task's own agents. Supervisors get rows of their own.
    const labelFor = (agent: WorkRunAgent) =>
        workers().length > 1 ? `Attempt ${workers().indexOf(agent) + 1}` : null

    return (
        <li>
            <div class="flex items-center gap-1">
                <button
                    class="w-7 shrink-0 self-stretch p-0 text-center caption muted"
                    aria-expanded={open() ? "true" : "false"}
                    aria-label={`${open() ? "Hide" : "Show"} agent output for ${props.item.ref}`}
                    title={
                        hasOutput()
                            ? "Agent output"
                            : "No agent has worked this task in this run yet."
                    }
                    disabled={!hasOutput()}
                    onClick={() => setOpen(!open())}>
                    {open() ? "\u25BE" : "\u25B8"}
                </button>
                <button
                    class="card-item row compact flex min-w-0 flex-1 items-center gap-3 px-3 py-2 text-left"
                    aria-current={
                        props.item.state === "working" ? "step" : undefined
                    }
                    onClick={() => props.openTask(props.item.ref)}>
                    <span class="w-5 text-right font-mono caption muted">
                        {props.index + 1}
                    </span>
                    <span class="font-mono caption muted w-12">
                        {props.item.ref}
                    </span>
                    <span class="min-w-0 flex-1 truncate text-sm">
                        {props.item.title}
                    </span>
                    <span
                        class={`badge ${
                            props.item.state === "done"
                                ? "success"
                                : unblocking()
                                  ? "warning"
                                  : props.item.state === "working"
                                    ? "accent"
                                    : ""
                        } p-[0.12rem_0.42rem]`}
                        aria-busy={
                            props.item.state === "working" && props.running
                                ? "true"
                                : "false"
                        }>
                        {unblocking()
                            ? "Unblocking"
                            : ITEM_LABELS[props.item.state]}
                    </span>
                    <Show when={props.item.status}>
                        {(status) => <StatusBadge status={status()} />}
                    </Show>
                </button>
            </div>
            <Show when={open() && hasOutput()}>
                <div class="mt-1 mb-2 ml-8 grid grid-cols-1 gap-2">
                    <For each={workers()}>
                        {(agent) => (
                            <AgentOutput
                                agent={agent}
                                label={labelFor(agent)}
                            />
                        )}
                    </For>
                </div>
            </Show>
            <For each={supervisors()}>
                {(agent) => (
                    <div class="mt-1">
                        <SupervisorRow
                            agent={agent}
                            afterResolved="It cleared the way, so a fresh agent picked the task back up with its report."
                            afterUnresolved="The run stopped here for a person."
                        />
                    </div>
                )}
            </For>
        </li>
    )
}

const STEP_LABELS: Record<PipelineStepState, string> = {
    waiting: "Waiting",
    running: "Running",
    done: "Done",
    skipped: "Skipped",
    stopped: "Stopped",
    blocked: "Needs attention",
}

const STEP_TONES: Record<PipelineStepState, string> = {
    waiting: "",
    running: "accent",
    done: "success",
    skipped: "",
    stopped: "",
    blocked: "warning",
}

/** One stage of a start-to-finish run, with an investigator's output folded
 *  away underneath. */
function PipelineStepRow(props: {
    runId: number
    step: PipelineStepDetail
    index: number
    running: boolean
}) {
    const key = () => `${props.runId}:step:${props.index}`
    const open = () => expanded().has(key())
    const setOpen = (value: boolean) =>
        setExpanded((current) => {
            const next = new Set(current)
            if (value) next.add(key())
            else next.delete(key())
            return next
        })
    const kind = () => {
        const step = props.step
        return step.kind === "investigation"
            ? step.ref
            : step.kind === "tasks"
              ? "Tasks"
              : BRANCH_STEP_LABELS[step.step]
    }
    const hasOutput = () => props.step.agents.length > 0

    return (
        <li>
            <div class="flex items-center gap-1">
                <button
                    class="w-7 shrink-0 self-stretch p-0 text-center caption muted"
                    aria-expanded={open() ? "true" : "false"}
                    aria-label={`${open() ? "Hide" : "Show"} agent output for ${props.step.title}`}
                    disabled={!hasOutput()}
                    onClick={() => setOpen(!open())}>
                    {hasOutput() ? (open() ? "\u25BE" : "\u25B8") : ""}
                </button>
                <div
                    class="card-item row compact flex min-w-0 flex-1 items-center gap-3 px-3 py-2"
                    aria-current={
                        props.step.state === "running" ? "step" : undefined
                    }>
                    <span class="w-5 text-right font-mono caption muted">
                        {props.index + 1}
                    </span>
                    <span class="min-w-0 flex-1">
                        <span class="block truncate text-sm">
                            <span class="caption muted">{kind()}</span>{" "}
                            {props.step.title}
                        </span>
                        <Show when={props.step.detail}>
                            <span class="block caption muted whitespace-pre-wrap">
                                {props.step.detail}
                            </span>
                        </Show>
                    </span>
                    <span
                        class={`badge ${STEP_TONES[props.step.state]} p-[0.12rem_0.42rem]`}
                        aria-busy={
                            props.step.state === "running" && props.running
                                ? "true"
                                : "false"
                        }>
                        {STEP_LABELS[props.step.state]}
                    </span>
                </div>
            </div>
            <Show when={open() && hasOutput()}>
                <div class="mt-1 mb-2 ml-8 grid grid-cols-1 gap-2">
                    <For each={props.step.agents}>
                        {(agent, attempt) => (
                            <AgentOutput
                                agent={agent}
                                label={
                                    props.step.agents.length > 1
                                        ? `Attempt ${attempt() + 1}`
                                        : null
                                }
                            />
                        )}
                    </For>
                </div>
            </Show>
        </li>
    )
}
