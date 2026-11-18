import {
    action,
    createEffect,
    createMemo,
    createOptimistic,
    createSignal,
    For,
    isPending,
    Loading,
} from "solid-js"
import type {
    AgentPermissionMode,
    AgentRun,
    AgentRunMode,
    GitConflict,
} from "@work-task-manager/shared"
import { api } from "../api"
import { useError } from "../hooks/useError"
import { AgentSettings } from "./AgentSettings"
import { Modal } from "./Modal"

/**
 * Offered when a merge or rebase stops on conflicts: hand it to an agent, or
 * leave it. The operation has already been aborted, so declining changes
 * nothing, and the agent re-runs it itself with the conflict report as its brief.
 *
 * Defaults to Codex on its fast tier. When `modelTiers` configures no fast tier
 * for Codex, the catalogue's Luna model stands in for it.
 */
export function ConflictAgentDialog(props: {
    conflict: GitConflict
    subject: { kind: string; ref: string }
    close: () => void
    started: (run: AgentRun) => void
}) {
    const environment = createMemo(() => api.agentEnvironment())
    const [harness, setHarness] = createSignal("")
    const [model, setModel] = createSignal("")
    const [mode, setMode] = createSignal<AgentRunMode>("terminal")
    const [permission, setPermission] =
        createSignal<AgentPermissionMode>("manual")
    const [extra, setExtra] = createSignal("")
    const [busy, setBusy] = createOptimistic(false)
    const { capture, clear, Banner } = useError()
    const preferred = (env: ReturnType<typeof environment>) =>
        env.harnesses.find((item) => item.id === "codex" && item.available)
            ?.id ??
        env.harnesses.find((item) => item.available)?.id ??
        ""
    const chosenHarness = () => harness() || preferred(environment())
    createEffect(
        () => environment(),
        (env) => {
            if (
                env.harnesses.some(
                    (item) => item.id === harness() && item.available,
                )
            )
                return
            setHarness(preferred(env))
        },
    )
    // AgentSettings resolves the configured fast tier; this covers a workspace
    // that configures none, once, without overriding a later choice of default.
    const luna = createMemo(async () => {
        const env = environment()
        if (env.modelTiers.codex?.fast) return null
        const models = await api.agentModels("codex").catch(() => [])
        return models.find((entry) => /luna/i.test(entry.id))?.id ?? null
    })
    createEffect(
        () => [chosenHarness(), luna()] as const,
        ([current, id]) => {
            if (current === "codex" && id && !model()) setModel(id)
        },
    )

    const verb = () =>
        props.conflict.operation === "merge"
            ? `Merging ${props.conflict.onto} into ${props.conflict.branch}`
            : `Rebasing ${props.conflict.branch} onto ${props.conflict.onto}`

    const run = action(async function* () {
        if (busy() || isPending(harness)) return

        setBusy(true)
        clear()
        try {
            if (!chosenHarness())
                throw new Error("No supported agent harness is installed.")
            const started = await api.startAgentRun({
                harness: chosenHarness(),
                model: model(),
                mode:
                    mode() === "terminal" && !environment().terminalAvailable
                        ? "print"
                        : mode(),
                command: "resolve-conflicts",
                target: props.conflict.branch,
                extra: extra(),
                subjectKind: props.subject.kind,
                subjectRef: props.subject.ref,
                permissionMode: permission(),
                conflict: props.conflict,
            })
            yield
            props.started(started)
            props.close()
        } catch (caught) {
            yield
            capture(caught)
        }
    })

    return (
        <Modal title="Resolve conflicts with an agent?" close={props.close}>
            <article class="tonal summary p-[1rem] [&_ul]:grid [&_ul]:gap-[0.4rem] [&_ul]:m-[0.8rem_0_0] [&_ul]:p-0 [&_li]:p-[0.55rem_0.65rem] [&_li_code]:break-all">
                <span class="block">{verb()}</span>
                <strong class="block mt-[0.35rem]">
                    {props.conflict.files.length} conflicted file
                    {props.conflict.files.length === 1 ? "" : "s"}
                </strong>
                <p class="m-[0.4rem_0_0]">
                    The {props.conflict.operation} was aborted, so nothing has
                    changed. An agent can run it again, resolve the conflicts,
                    and finish it. It will not push.
                </p>
                <ul>
                    <For each={props.conflict.files}>
                        {(file) => (
                            <li>
                                <code>{file}</code>
                            </li>
                        )}
                    </For>
                </ul>
            </article>
            <Loading
                fallback={
                    <p class="mt-5 description">Checking installed agents…</p>
                }>
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
                    recommendedTier="fast"
                />
            </Loading>
            <label class="field mt-4">
                <span>Extra instructions</span>
                <textarea
                    value={extra()}
                    onInput={(event) => setExtra(event.currentTarget.value)}
                    placeholder="Optional guidance, such as which side should win"
                />
            </label>
            <Banner />
            <div class="mt-5 flex justify-end gap-[0.5rem]">
                <button class="outlined" onClick={props.close}>
                    Not now
                </button>
                <button
                    aria-busy={busy() ? "true" : "false"}
                    class="primary"
                    disabled={busy() || isPending(harness)}
                    onClick={run}>
                    Resolve with agent
                </button>
            </div>
        </Modal>
    )
}
