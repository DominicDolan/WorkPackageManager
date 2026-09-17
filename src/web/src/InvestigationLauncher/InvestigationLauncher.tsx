import {
    action,
    createOptimistic,
    Loading,
    Show,
    createEffect,
    createMemo,
    createSignal,
} from "solid-js"
import type {
    AgentPermissionMode,
    AgentRunMode,
    Investigation,
} from "@shared/types"
import { api } from "../api"
import { AgentSettings } from "../components/AgentSettings"
import { Modal } from "../components/Modal"

export function InvestigationLauncher(props: {
    investigation: Investigation
    close: () => void
    started: () => void
}) {
    const environment = createMemo(() => api.agentEnvironment())
    const [harness, setHarness] = createSignal("")
    const [model, setModel] = createSignal("")
    const [mode, setMode] = createSignal<AgentRunMode>("terminal")
    const [permission, setPermission] =
        createSignal<AgentPermissionMode>("manual")
    const [extra, setExtra] = createSignal("")
    const [busy, setBusy] = createOptimistic(false)
    const [error, setError] = createSignal("")
    const chosenHarness = () =>
        harness() ||
        environment().harnesses.find(
            (item) => item.id === "codex" && item.available,
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
                    (item) => item.id === "codex" && item.available,
                )?.id ??
                    env.harnesses.find((item) => item.available)?.id ??
                    "",
            )
        },
    )
    const run = action(function* () {
        if (busy()) return

        setBusy(true)
        setError("")
        try {
            if (!chosenHarness())
                throw new Error("No supported agent harness is installed.")
            yield api.startAgentRun({
                harness: chosenHarness(),
                model: model(),
                mode:
                    mode() === "terminal" && !environment().terminalAvailable
                        ? "print"
                        : mode(),
                command: "plan-tasks",
                target: props.investigation.ref,
                extra: extra(),
                subjectKind: "investigation",
                subjectRef: props.investigation.ref,
                permissionMode: permission(),
            })

            props.started()
            props.close()
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught))
        }
    })
    return (
        <Modal title="Run investigation" close={props.close}>
            <article class="inset summary p-[1rem] [&_span]:block [&_strong]:block [&_strong]:mt-[0.25rem] [&_p]:m-[0.5rem_0_0]">
                <span>{props.investigation.ref}</span>
                <strong>{props.investigation.title}</strong>
                <p>
                    The agent will investigate this brief, record its findings,
                    and create tasks in the linked work package. It will not
                    change product code.
                </p>
            </article>
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
                    unattended={false}
                />
            </Loading>
            <label class="field mt-4">
                <span>Extra instructions</span>
                <textarea
                    value={extra()}
                    onInput={(event) => setExtra(event.currentTarget.value)}
                    placeholder="Optional context for this run"
                />
            </label>
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
                    Start investigation
                </button>
            </div>
        </Modal>
    )
}
