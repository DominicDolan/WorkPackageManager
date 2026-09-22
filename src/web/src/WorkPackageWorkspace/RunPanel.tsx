import {
    RECOMMENDED_MODEL,
    WORK_RUN_KIND_LABELS,
    type AgentRunDetail,
    type WorkPackageDetail,
    type WorkRunAgent,
    type WorkRunDetail,
    type WorkRunItem,
    type WorkRunStatus,
} from "@shared/types"
import {
    action,
    createOptimistic,
    createSignal,
    For,
    onSettled,
    Show,
} from "solid-js"
import { api } from "../api"
import { StatusBadge } from "../components/StatusBadge"
import { useError } from "../hooks/useError"
import { renderMarkdown } from "../markdown"
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
}) {
    const [busy, setBusy] = createOptimistic("")
    const { capture, clear, Banner } = useError()
    const running = () => props.run.status === "running"
    const agent = () => props.run.agentRun
    // An unattended loop that has settled any way but finishing can carry on
    // from where it got to.
    const resumable = () =>
        props.run.kind === "unattended" &&
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
        <section class="mx-auto grid max-w-4xl gap-[1.1rem]">
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
                <dl class="m-0 grid gap-x-6 gap-y-3 sm:grid-cols-4 [&_dt]:text-xs [&_dt]:text-slate-400 [&_dd]:m-0 [&_dd]:text-sm">
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
                            title="Start the loop again. The task it stopped on goes to a fresh agent, handed the task and what the last agent left behind."
                            onClick={() =>
                                act("resume", () =>
                                    api.resumeWorkRun(
                                        props.workPackage.ref,
                                        props.run.id,
                                    ),
                                )
                            }>
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

            <article class="elevated p-5">
                <header class="flex items-baseline justify-between gap-3">
                    <h3 class="m-0">Tasks</h3>
                    <span class="caption muted">
                        {done()} of {props.run.items.length} worked
                    </span>
                </header>
                <ol
                    class="mt-4 grid gap-1 p-0"
                    style={{ "list-style": "none" }}>
                    <For
                        each={props.run.items}
                        fallback={
                            <li class="hint">This run had no tasks to work.</li>
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

/** A task in the run, with the output of the agents that worked it folded
 *  away underneath. */
/*
 * Keep expansion and cached output across tab switches and page navigation.
 * Background refreshes reconcile the run in place and retain its mounted UI.
 */
const [expanded, setExpanded] = createSignal<ReadonlySet<string>>(new Set())

interface SeenOutput {
    detail: AgentRunDetail
    /** Null while the reader is following the end of the log. */
    scrollTop: number | null
}
const seenOutput = new Map<number, SeenOutput>()
/** Agents whose working is unfolded under their final answer. */
const [showingWorking, setShowingWorking] = createSignal<ReadonlySet<number>>(
    new Set(),
)

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
    const hasOutput = () => props.item.agents.length > 0
    const unblocking = () => {
        const last = props.item.agents.at(-1)
        return (
            props.running &&
            last?.command === "supervise-task" &&
            last.status === "running"
        )
    }
    // Numbered among the task's own agents; a supervisor is named as one.
    const labelFor = (agent: WorkRunAgent) => {
        if (agent.command === "supervise-task") return "Supervisor"
        const workers = props.item.agents.filter(
            (one) => one.command !== "supervise-task",
        )
        return workers.length > 1
            ? `Attempt ${workers.indexOf(agent) + 1}`
            : null
    }

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
                <div class="mt-1 mb-2 ml-8 grid gap-2">
                    <For each={props.item.agents}>
                        {(agent) => (
                            <AgentOutput
                                agent={agent}
                                label={labelFor(agent)}
                            />
                        )}
                    </For>
                </div>
            </Show>
        </li>
    )
}

const AGENT_STATUS_LABELS: Record<WorkRunAgent["status"], string> = {
    launched: "Launched",
    running: "Running",
    succeeded: "Exited cleanly",
    failed: "Failed",
    stopped: "Stopped",
}

/**
 * One headless agent's saved log. Fetched only once it is opened, and
 * followed while the agent is still writing to it.
 */
function AgentOutput(props: { agent: WorkRunAgent; label: string | null }) {
    const seen = seenOutput.get(props.agent.id)
    const [detail, setDetail] = createSignal<AgentRunDetail | null>(
        seen?.detail ?? null,
    )
    const { capture, Banner } = useError()
    let log: HTMLPreElement | undefined

    // Keep following the end of the log, unless someone has scrolled up to
    // read something — in which case leave them where they are.
    const restoreScroll = () =>
        requestAnimationFrame(() => {
            if (!log) return
            const scrollTop = seenOutput.get(props.agent.id)?.scrollTop ?? null
            log.scrollTop = scrollTop ?? log.scrollHeight
        })
    const rememberScroll = () => {
        const remembered = seenOutput.get(props.agent.id)
        if (!log || !remembered) return
        remembered.scrollTop =
            log.scrollHeight - log.scrollTop - log.clientHeight < 40
                ? null
                : log.scrollTop
    }

    const load = async () => {
        try {
            const next = await api.getAgentRun(props.agent.id)
            seenOutput.set(props.agent.id, {
                detail: next,
                scrollTop: seenOutput.get(props.agent.id)?.scrollTop ?? null,
            })
            setDetail(next)
            restoreScroll()
        } catch (caught) {
            capture(caught)
        }
    }

    onSettled(() => {
        if (seen) restoreScroll()
        // A finished agent's log will not change, so once seen it is not
        // fetched again.
        if (!seen || seen.detail.status === "running") void load()
        const poll = setInterval(() => {
            const status = detail()?.status ?? props.agent.status
            if (status === "running") void load()
        }, 2000)
        return () => clearInterval(poll)
    })

    const status = () => detail()?.status ?? props.agent.status
    // With a final answer to show, the working behind it is folded away until
    // asked for. Without one — still going, or stopped before answering — the
    // working is all there is.
    const result = () => detail()?.result ?? null
    const working = () => !result() || showingWorking().has(props.agent.id)
    const toggleWorking = () => {
        setShowingWorking((current) => {
            const next = new Set(current)
            if (next.has(props.agent.id)) next.delete(props.agent.id)
            else next.add(props.agent.id)
            return next
        })
        restoreScroll()
    }

    return (
        <div class="tonal p-3">
            <header class="flex flex-wrap items-baseline gap-2 caption muted">
                <Show when={props.label}>
                    {(label) => <span class="font-medium">{label()}</span>}
                </Show>
                <span aria-busy={status() === "running" ? "true" : "false"}>
                    {AGENT_STATUS_LABELS[status()]}
                    {detail()?.exitCode !== null &&
                    detail()?.exitCode !== undefined &&
                    detail()?.exitCode !== 0
                        ? ` (exit ${detail()!.exitCode})`
                        : ""}
                </span>
                <time class="ml-auto">
                    {new Date(props.agent.createdAt).toLocaleString()}
                </time>
            </header>
            <Banner />
            <Show when={result()}>
                {(answer) => (
                    <>
                        <article
                            class="prose mt-2 text-sm"
                            innerHTML={renderMarkdown(answer())}
                        />
                        <button
                            class="outlined mt-2 p-[0.2rem_0.6rem] caption"
                            aria-expanded={working() ? "true" : "false"}
                            onClick={toggleWorking}>
                            {working() ? "Hide working" : "Show working"}
                        </button>
                    </>
                )}
            </Show>
            <Show when={working() && detail()?.truncated}>
                <p class="hint m-0 mt-2">
                    The log is long, so only its end is shown.
                </p>
            </Show>
            <Show when={working()}>
                <pre
                    ref={log}
                    onScroll={rememberScroll}
                    class="mt-2 mb-0 max-h-[28rem] overflow-auto whitespace-pre-wrap p-3 text-xs">
                    {detail() === null
                        ? "Loading…"
                        : detail()!.output ||
                          (status() === "running"
                              ? "Nothing written yet."
                              : "This agent wrote no output.")}
                </pre>
            </Show>
        </div>
    )
}
