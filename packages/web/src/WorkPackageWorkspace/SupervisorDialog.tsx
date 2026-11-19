import {
    MAX_SUPERVISIONS_PER_TASK,
    type AgentHarnessId,
    type AgentPermissionMode,
    type RunSupervisor,
    type WorkRunDetail,
} from "@work-task-manager/shared"
import { createMemo, createSignal, Loading, Show } from "solid-js"
import { api } from "../api"
import { Modal } from "../components/Modal"
import { SupervisorFields } from "../components/SupervisorFields"
import { useError } from "../hooks/useError"

/**
 * Attach a supervisor to an unattended run already under way, or change or
 * remove the one it has. An agent already at work carries on untouched; the
 * change applies from the next task that stops short.
 */
export function SupervisorDialog(props: {
    workPackageRef: string
    run: WorkRunDetail
    close: () => void
    changed: () => void
}) {
    const current = props.run.supervisor
    const environment = createMemo(() => api.agentEnvironment())
    // A new supervisor starts as the same agent the run's tasks use.
    const [harness, setHarness] = createSignal<string>(
        current?.harness ?? props.run.harness,
    )
    const [model, setModel] = createSignal(current?.model ?? "")
    const [permission, setPermission] = createSignal<AgentPermissionMode>(
        current?.permissionMode ?? "bypassPermissions",
    )
    const [extra, setExtra] = createSignal(current?.extra ?? "")
    const [busy, setBusy] = createSignal("")
    const { capture, clear, Banner } = useError()

    const save = async (label: string, supervisor: RunSupervisor | null) => {
        if (busy()) return
        setBusy(label)
        clear()
        try {
            await api.setWorkRunSupervisor(
                props.workPackageRef,
                props.run.id,
                supervisor,
            )
            props.changed()
            props.close()
        } catch (caught) {
            capture(caught)
            setBusy("")
        }
    }

    return (
        <Modal
            title={current ? "Change supervisor" : "Add a supervisor"}
            close={props.close}>
            <p class="description m-0">
                When a task stops short of Dev Complete, the supervisor steps in
                for you: it makes the call the task's agent stopped to ask
                about, or fixes what broke, and then the run carries on. It is
                called in at most {MAX_SUPERVISIONS_PER_TASK} times per task.
                {props.run.status === "running"
                    ? " The agent at work now is left alone; this applies from the next task that stops short."
                    : " Resume the run to put it to work."}
            </p>
            <Loading
                fallback={
                    <p class="mt-5 description">Checking installed agents…</p>
                }>
                <SupervisorFields
                    environment={environment()}
                    machine={props.run.machine ?? ""}
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
                <Show when={current}>
                    <button
                        class="outlined"
                        aria-busy={busy() === "remove" ? "true" : "false"}
                        disabled={!!busy()}
                        onClick={() => save("remove", null)}>
                        Remove supervisor
                    </button>
                </Show>
                <button
                    class="primary"
                    aria-busy={busy() === "save" ? "true" : "false"}
                    disabled={!!busy() || !harness()}
                    onClick={() =>
                        save("save", {
                            harness: harness() as AgentHarnessId,
                            model: model(),
                            permissionMode: permission(),
                            extra: extra(),
                        })
                    }>
                    {current ? "Save" : "Add supervisor"}
                </button>
            </div>
        </Modal>
    )
}
