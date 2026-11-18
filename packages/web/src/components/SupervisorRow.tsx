import type { WorkRunAgent } from "@work-task-manager/shared"
import { createSignal, Show } from "solid-js"
import { AgentOutput } from "./AgentOutput"
import { ResumeSessionButton } from "./ResumeSessionButton"

/** Rows that are unfolded, kept across refreshes that remount the list. */
const [unfolded, setUnfolded] = createSignal<ReadonlySet<number>>(new Set())

type Outcome = { label: string; tone: string; busy?: boolean }

function outcomeOf(agent: WorkRunAgent): Outcome {
    if (agent.status === "running" || agent.status === "launched")
        return { label: "Working", tone: "info", busy: true }
    if (agent.status === "stopped") return { label: "Stopped", tone: "" }
    if (agent.status === "failed") return { label: "Error", tone: "error" }
    if (agent.verdict === "resolved")
        return { label: "Resolved", tone: "success" }
    if (agent.verdict === "unresolved")
        return { label: "Needs a person", tone: "warning" }
    return { label: "No verdict", tone: "warning" }
}

function duration(agent: WorkRunAgent): string {
    if (!agent.finishedAt) return ""
    const seconds = Math.max(
        0,
        Math.round(
            (Date.parse(agent.finishedAt) - Date.parse(agent.createdAt)) / 1000,
        ),
    )
    return seconds < 60
        ? `${seconds}s`
        : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

/**
 * One time a supervisor was called in, as a row of its own under whatever it
 * was called in on: why, what it concluded, and what happened next. Unfolds
 * into the supervisor's output.
 */
export function SupervisorRow(props: {
    agent: WorkRunAgent
    /** What happened after it said it had cleared the way. */
    afterResolved: string
    /** What happened after it said it could not. */
    afterUnresolved: string
}) {
    const open = () => unfolded().has(props.agent.id)
    const outcome = () => outcomeOf(props.agent)
    const consequence = () => {
        const { status, verdict } = props.agent
        if (status === "running" || status === "launched")
            return "It is working on this now."
        if (status === "stopped")
            return "It was stopped before it finished, so the run stopped with it."
        if (status === "failed")
            return "It exited with an error, so the run stopped for a person."
        if (verdict === "resolved") return props.afterResolved
        if (verdict === "unresolved") return props.afterUnresolved
        return `It ended without a verdict, which counts as unresolved. ${props.afterUnresolved}`
    }

    return (
        <details
            class="supervisor"
            open={open()}
            onToggle={(event) => {
                const next = event.currentTarget.open
                if (next === open()) return
                setUnfolded((current) => {
                    const copy = new Set(current)
                    if (next) copy.add(props.agent.id)
                    else copy.delete(props.agent.id)
                    return copy
                })
            }}>
            <summary class="flex min-w-0 items-center gap-3 px-3 py-2">
                <strong class="shrink-0">Supervisor</strong>
                <span class="min-w-0 flex-1 truncate">
                    {props.agent.calledFor ?? "Called in"}
                </span>
                <span class="caption muted tabular-nums">
                    {duration(props.agent)}
                </span>
                <span
                    class={`badge ${outcome().tone} p-[0.12rem_0.42rem]`}
                    aria-busy={outcome().busy ? "true" : "false"}>
                    {outcome().label}
                </span>
            </summary>
            <div class="grid gap-2 px-3 pb-3">
                <Show when={props.agent.calledFor}>
                    {(reason) => (
                        <p class="m-0">
                            <strong>Called in because:</strong> {reason()}
                        </p>
                    )}
                </Show>
                <p class="m-0">{consequence()}</p>
                <div>
                    <ResumeSessionButton agent={props.agent} />
                </div>
                {/* Mounted only when unfolded: it fetches the agent's log. */}
                <Show when={open()}>
                    <AgentOutput agent={props.agent} label={null} />
                </Show>
            </div>
        </details>
    )
}
