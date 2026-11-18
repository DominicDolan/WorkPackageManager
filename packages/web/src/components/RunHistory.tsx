import type { AgentRun } from "@work-task-manager/shared"
import { action, createOptimistic, For } from "solid-js"
import { api } from "../api"
import { useError } from "../hooks/useError"

/** Earlier agent runs, newest first, each reopenable in a terminal when its
 *  conversation id is known. */
export function RunHistory(props: { runs: AgentRun[] }) {
    const [resuming, setResuming] = createOptimistic<number | null>(null)
    const { capture, clear, Banner } = useError()
    const resume = action(function* (entry: AgentRun) {
        if (resuming() !== null || !entry.sessionId) return

        setResuming(entry.id)
        clear()
        try {
            yield api.resumeAgentRun(entry.id)
        } catch (caught) {
            capture(caught)
        }
    })

    return (
        <>
            <ul class="space-y-2">
                <For each={props.runs}>
                    {(entry) => (
                        <li class="flex flex-wrap items-center gap-2 tonal px-3 py-2 text-xs">
                            <span class="font-medium capitalize text-slate-700">
                                {entry.status}
                            </span>
                            <span class="font-mono text-slate-500">
                                {entry.harness}
                                {entry.model ? ` · ${entry.model}` : ""}
                            </span>
                            <span class="text-slate-400">
                                {entry.mode === "print"
                                    ? "Headless"
                                    : "Terminal"}
                            </span>
                            <time class="ml-auto text-slate-400">
                                {new Date(entry.createdAt).toLocaleString()}
                            </time>
                            <button
                                aria-busy={
                                    resuming() === entry.id ? "true" : "false"
                                }
                                class="outlined px-2 py-1 text-xs"
                                disabled={
                                    !entry.sessionId || resuming() !== null
                                }
                                title={
                                    entry.sessionId
                                        ? `Reopen this ${entry.harness} conversation in a terminal`
                                        : "No conversation id has been recorded for this run, so it cannot be reopened."
                                }
                                onClick={() => resume(entry)}>
                                Resume
                            </button>
                        </li>
                    )}
                </For>
            </ul>
            <Banner />
        </>
    )
}
