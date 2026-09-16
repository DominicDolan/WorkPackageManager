import { Loading, Show, createEffect, createMemo, createSignal } from "solid-js"
import type {
    AgentPermissionMode,
    AgentRunMode,
    Investigation,
} from "@shared/types"
import { api } from "../api"
import { AgentSettings } from "../components/AgentSettings"
import { Modal } from "../components/Modal"
import styles from "./InvestigationLauncher.module.css"

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
    const [busy, setBusy] = createSignal(false)
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
    const run = async () => {
        setBusy(true)
        setError("")
        try {
            if (!chosenHarness())
                throw new Error("No supported agent harness is installed.")
            await api.startAgentRun({
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
        } finally {
            setBusy(false)
        }
    }
    return (
        <Modal title="Run investigation" close={props.close}>
            <div
                class={`${styles.scope} investigation-run-summary p-[1rem] [&_span]:block [&_strong]:block [&_strong]:mt-[0.25rem] [&_p]:m-[0.5rem_0_0]`}
            >
                <span>{props.investigation.ref}</span>
                <strong>{props.investigation.title}</strong>
                <p>
                    The agent will investigate this brief, record its findings,
                    and create tasks in the linked work package. It will not
                    change product code.
                </p>
            </div>
            <Loading
                fallback={
                    <p class="mt-5 text-sm text-slate-500">
                        Checking installed agents…
                    </p>
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
            <label class="field mt-4 grid gap-[0.45rem] [&_input]:w-full [&_input]:p-[0.68rem_0.75rem] [&_select]:w-full [&_select]:p-[0.68rem_0.75rem] [&_textarea]:w-full [&_textarea]:p-[0.68rem_0.75rem] [&_textarea]:min-h-[7rem]">
                <span>Extra instructions</span>
                <textarea
                    value={extra()}
                    onInput={(event) => setExtra(event.currentTarget.value)}
                    placeholder="Optional context for this run"
                />
            </label>
            <Show when={error()}>
                <p class="banner mt-4 p-[0.8rem_1rem]">{error()}</p>
            </Show>
            <div class="mt-5 flex justify-end">
                <button
                    class="button-primary inline-flex min-h-[2.5rem] items-center justify-center gap-[0.45rem] p-[0.5rem_0.9rem]"
                    disabled={busy()}
                    onClick={run}
                >
                    {busy() ? "Starting…" : "Start investigation"}
                </button>
            </div>
        </Modal>
    )
}
