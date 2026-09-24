import {
    type AgentHarnessId,
    type AgentPermissionMode,
    type RunSupervisor,
} from "@shared/types"
import {
    createEffect,
    createMemo,
    createSignal,
    Loading,
    type Element,
} from "solid-js"
import { api } from "../api"
import { useError } from "../hooks/useError"
import { Modal } from "./Modal"
import { SupervisorFields } from "./SupervisorFields"

/**
 * Choose the agent that stands by while something runs unattended, before it
 * starts. Starts as the previous supervisor, when there was one, so a second
 * run is one click.
 */
export function SupervisorPickerDialog(props: {
    title: string
    /** What the supervisor will be called in for. */
    description: Element
    action: string
    previous: RunSupervisor | null
    close: () => void
    start: (supervisor: RunSupervisor) => Promise<void>
}) {
    const environment = createMemo(() => api.agentEnvironment())
    const [harness, setHarness] = createSignal<string>(
        props.previous?.harness ?? "",
    )
    const [model, setModel] = createSignal(props.previous?.model ?? "")
    const [permission, setPermission] = createSignal<AgentPermissionMode>(
        props.previous?.permissionMode ?? "bypassPermissions",
    )
    const [extra, setExtra] = createSignal(props.previous?.extra ?? "")
    const [busy, setBusy] = createSignal(false)
    const { capture, clear, Banner } = useError()

    // Fall back to an installed agent when there is no previous one, or it
    // has since gone.
    createEffect(
        () => environment(),
        (env) => {
            if (
                env.harnesses.some(
                    (item) => item.id === harness() && item.available,
                )
            )
                return
            setHarness(env.harnesses.find((item) => item.available)?.id ?? "")
        },
    )

    const start = async () => {
        if (busy()) return
        setBusy(true)
        clear()
        try {
            await props.start({
                harness: harness() as AgentHarnessId,
                model: model(),
                permissionMode: permission(),
                extra: extra(),
            })
            props.close()
        } catch (caught) {
            capture(caught)
            setBusy(false)
        }
    }

    return (
        <Modal title={props.title} close={props.close}>
            <p class="description m-0">{props.description}</p>
            <Loading
                fallback={
                    <p class="mt-5 description">Checking installed agents…</p>
                }>
                <SupervisorFields
                    environment={environment()}
                    harness={harness()}
                    setHarness={setHarness}
                    model={model()}
                    setModel={setModel}
                    permission={permission()}
                    setPermission={setPermission}
                    extra={extra()}
                    setExtra={setExtra}
                />
            </Loading>
            <Banner />
            <div class="mt-5 flex justify-end gap-2">
                <button
                    class="primary"
                    aria-busy={busy() ? "true" : "false"}
                    disabled={busy() || !harness()}
                    onClick={start}>
                    {props.action}
                </button>
            </div>
        </Modal>
    )
}
