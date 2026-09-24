import type { AgentRunDetail, WorkRunAgent } from "@shared/types"
import { createSignal, onSettled, Show } from "solid-js"
import { api } from "../api"
import { useError } from "../hooks/useError"
import { renderMarkdown } from "../markdown"

/*
 * Cached output and scroll positions survive tab switches, page navigation and
 * background refreshes that remount a row.
 */
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
export function AgentOutput(props: {
    agent: WorkRunAgent
    label: string | null
}) {
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
