import {
    RECOMMENDED_MODEL,
    type AgentHarnessId,
    type AgentPermissionMode,
    type WorkRunDetail,
} from "@shared/types"
import {
    action,
    createMemo,
    createOptimistic,
    createSignal,
    isPending,
    Loading,
    Show,
} from "solid-js"
import { api } from "../api"
import { AgentSettings } from "../components/AgentSettings"
import { Modal } from "../components/Modal"
import { ModelPicker } from "../components/ModelPicker"
import { useError } from "../hooks/useError"

export function ResumePipelineDialog(props: {
    run: WorkRunDetail
    close: () => void
    changed: () => void
}) {
    const plan = props.run.pipeline!.plan
    const environment = createMemo(() => api.agentEnvironment())
    const [harness, setHarness] = createSignal<string>(plan.agent.harness)
    const [model, setModel] = createSignal(plan.agent.model)
    const [permission, setPermission] = createSignal<AgentPermissionMode>(
        plan.agent.permissionMode,
    )
    const [extra, setExtra] = createSignal(plan.agent.extra)
    const [taskModel, setTaskModel] = createSignal(
        plan.taskRun?.model ?? RECOMMENDED_MODEL,
    )
    const [taskExtra, setTaskExtra] = createSignal(plan.taskRun?.extra ?? "")
    const models = createMemo(async () => {
        const current = harness()
        return {
            harness: current,
            entries: await api.agentModels(current).catch(() => []),
        }
    })
    const [busy, setBusy] = createOptimistic(false)
    const { capture, clear, Banner } = useError()
    const available = () =>
        !isPending(environment) &&
        environment().harnesses.some(
            (item) => item.id === harness() && item.available,
        )

    const resume = action(async function* () {
        if (busy() || !available()) return
        setBusy(true)
        clear()
        try {
            await api.resumeWorkRun(props.run.workPackageRef, props.run.id, {
                agent: {
                    harness: harness() as AgentHarnessId,
                    model: model(),
                    permissionMode: permission(),
                    extra: extra(),
                },
                taskRun: plan.taskRun
                    ? { model: taskModel(), extra: taskExtra() }
                    : undefined,
            })
            yield
            props.changed()
            props.close()
        } catch (caught) {
            yield
            capture(caught)
        }
    })

    return (
        <Modal title="Resume run" close={props.close}>
            <p class="description m-0">
                Continue from the stage where this run stopped. These settings
                apply to the resumed stage and the remaining work. Completed
                stages and your task selection are kept.
            </p>
            <Loading
                fallback={
                    <p class="mt-5 description">Checking installed agents…</p>
                }>
                <AgentSettings
                    environment={environment()}
                    harness={harness()}
                    setHarness={(value) => {
                        if (value !== harness()) setTaskModel(RECOMMENDED_MODEL)
                        setHarness(value)
                    }}
                    model={model()}
                    setModel={setModel}
                    mode="print"
                    setMode={() => {}}
                    permission={permission()}
                    setPermission={setPermission}
                    unattended
                    perTaskModel={false}
                />
                <Show when={!available()}>
                    <p class="hint">Choose an installed agent to resume.</p>
                </Show>
            </Loading>
            <label class="field mt-4">
                <span>Instructions for the agent</span>
                <textarea
                    value={extra()}
                    onInput={(event) => setExtra(event.currentTarget.value)}
                    placeholder="Optional: how you would want decisions and blockers handled…"
                />
            </label>
            <Show when={plan.taskRun}>
                <section class="mt-5 border-t border-slate-200 pt-5">
                    <h3 class="m-0">Task agents</h3>
                    <p class="caption muted mt-1 mb-3">
                        Each task uses the harness above, with its own model and
                        instructions.
                    </p>
                    <Loading
                        fallback={
                            <ModelPicker
                                harness={harness()}
                                models={[]}
                                value=""
                                setValue={() => {}}
                                defaultLabel="Harness default"
                                recommended
                                busy
                            />
                        }>
                        <ModelPicker
                            harness={harness()}
                            models={
                                isPending(models) ||
                                models().harness !== harness()
                                    ? []
                                    : models().entries
                            }
                            busy={isPending(models)}
                            value={taskModel()}
                            setValue={setTaskModel}
                            defaultLabel="Harness default"
                            recommended
                        />
                    </Loading>
                    <label class="field mt-3">
                        <span>Instructions for task agents</span>
                        <textarea
                            value={taskExtra()}
                            onInput={(event) =>
                                setTaskExtra(event.currentTarget.value)
                            }
                            placeholder="Optional context for every task…"
                        />
                    </label>
                </section>
            </Show>
            <Banner />
            <div class="mt-5 flex justify-end gap-2">
                <button
                    class="outlined"
                    disabled={busy()}
                    onClick={props.close}>
                    Cancel
                </button>
                <button
                    class="primary"
                    aria-busy={busy() ? "true" : "false"}
                    disabled={busy() || !available()}
                    onClick={resume}>
                    Resume run
                </button>
            </div>
        </Modal>
    )
}
