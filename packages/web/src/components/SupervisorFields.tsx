import type {
    AgentEnvironment,
    AgentPermissionMode,
} from "@work-task-manager/shared"
import { AgentSettings } from "./AgentSettings"

/**
 * The settings for an unattended run's supervisor: which agent, and anything
 * it should be told on top of its own instructions. Shared by the dialog that
 * starts a run and the one that attaches a supervisor to a run under way.
 */
export function SupervisorFields(props: {
    environment: AgentEnvironment
    /** The loop's machine, which the supervisor runs on too. Fixed by the
     *  loop, so it narrows the agents offered but is not chosen here. */
    machine?: string
    harness: string
    setHarness: (value: string) => void
    model: string
    setModel: (value: string) => void
    permission: AgentPermissionMode
    setPermission: (value: AgentPermissionMode) => void
    extra: string
    setExtra: (value: string) => void
}) {
    return (
        <>
            {/* Always headless, like the rest of the loop, so there is no
                run mode to choose. */}
            <AgentSettings
                environment={props.environment}
                machine={props.machine}
                harness={props.harness}
                setHarness={props.setHarness}
                model={props.model}
                setModel={props.setModel}
                mode="print"
                setMode={() => {}}
                permission={props.permission}
                setPermission={props.setPermission}
                unattended
            />
            <label class="field mt-4">
                <span>Supervisor instructions</span>
                <textarea
                    value={props.extra}
                    onInput={(event) =>
                        props.setExtra(event.currentTarget.value)
                    }
                    placeholder="Optional: how you would want blockers handled…"
                />
            </label>
        </>
    )
}
