import type { WorkRunAgent } from "@shared/types"
import { action, createOptimistic } from "solid-js"
import { api } from "../api"
import { useError } from "../hooks/useError"

/**
 * Reopens a supervisor's conversation in a new terminal window, so a person
 * can read what it did and carry on. Disabled while the supervisor is still
 * working, because its headless process is writing to the same session.
 */
export function ResumeSessionButton(props: { agent: WorkRunAgent }) {
    const [busy, setBusy] = createOptimistic(false)
    const { capture, clear, Banner } = useError()
    const working = () =>
        props.agent.status === "running" || props.agent.status === "launched"

    const reopen = action(function* () {
        if (busy()) return
        setBusy(true)
        clear()
        try {
            yield api.resumeAgentRun(props.agent.id)
        } catch (caught) {
            capture(caught)
        } finally {
            setBusy(false)
        }
    })

    return (
        <>
            <button
                class="outlined"
                aria-busy={busy() ? "true" : "false"}
                disabled={busy() || working() || !props.agent.sessionId}
                title={
                    !props.agent.sessionId
                        ? "This supervisor has no recorded conversation ID to reopen."
                        : working()
                          ? "It is still working. Reopen it once it has finished."
                          : "Reopen this supervisor's conversation in a terminal"
                }
                onClick={() => reopen()}>
                Resume in a terminal
            </button>
            <Banner />
        </>
    )
}
