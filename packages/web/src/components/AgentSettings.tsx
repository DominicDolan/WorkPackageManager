import {
    AGENT_PERMISSION_MODE_LABELS,
    type AgentEnvironment,
    type AgentHarnessInfo,
    type AgentPermissionMode,
    type AgentRunMode,
    type ModelTier,
} from "@work-task-manager/shared"
import {
    For,
    Show,
    Loading,
    createEffect,
    createMemo,
    isPending,
    latest,
} from "solid-js"
import { api } from "../api"
import claudeIcon from "../assets/claude-code-icon.png"
import codexIcon from "../assets/codex-icon.svg"
import piIcon from "../assets/pi-agent-icon.svg"
import { ModelPicker } from "./ModelPicker"

/**
 * The harnesses a run can use on `machine` (empty for this computer). Here,
 * that is whatever is on PATH. On a configured machine it is whatever the
 * config lists, since nothing can look.
 */
export function usableHarnesses(
    environment: AgentEnvironment,
    machine: string,
): AgentHarnessInfo[] {
    const remote = environment.machines.find((item) => item.id === machine)
    if (!remote) return environment.harnesses.filter((item) => item.available)
    return environment.harnesses.filter((item) =>
        remote.harnesses.includes(item.id),
    )
}

/** The harness a dialog starts on: Codex when it can run there, else the first
 *  that can, else nothing. */
export function defaultHarness(
    environment: AgentEnvironment,
    machine: string,
): string {
    const usable = usableHarnesses(environment, machine)
    return usable.find((item) => item.id === "codex")?.id ?? usable[0]?.id ?? ""
}

export function AgentSettings(props: {
    environment: AgentEnvironment
    /** The configured machine to run on; empty for this computer. The picker
     *  only appears when `setMachine` is given and machines are configured. */
    machine?: string
    setMachine?: (value: string) => void
    harness: string
    setHarness: (value: string) => void
    model: string
    setModel: (value: string) => void
    mode: AgentRunMode
    setMode: (value: AgentRunMode) => void
    permission: AgentPermissionMode
    setPermission: (value: AgentPermissionMode) => void
    unattended: boolean
    recommendedTier?: ModelTier | null
    /** Offer "Recommended for each task". Defaults to `unattended`; an agent
     *  that is not itself working a task has no tier to follow. */
    perTaskModel?: boolean
}) {
    // A dialog can render a second settings group for an unattended run's
    // supervisor. Keep the native radio groups independent in that case.
    const radioGroup = `agent-settings-${Math.random().toString(36).slice(2)}`
    const available = () =>
        usableHarnesses(props.environment, props.machine ?? "")
    const selectedHarness = () =>
        props.environment.harnesses.find(
            (item) => item.id === latest(() => props.harness),
        )
    // Solid owns request ordering. Failed catalogues retain the harness-default
    // option; a pending catalogue must never offer another harness's models.
    const models = createMemo(async () => {
        const harness = props.harness
        const entries = harness
            ? await api.agentModels(harness).catch(() => [])
            : []
        return { harness, entries }
    })
    const defaultLabel = () =>
        selectedHarness()
            ? `Default (${selectedHarness()!.label}'s configured model)`
            : "Harness default"
    // A recommendation is a starting point, not a restriction. Resolve it only
    // after this harness's catalogue arrives; a user choosing the harness default
    // later leaves the value empty and is not overwritten.
    createEffect(
        () => [props.harness, models()] as const,
        ([harness, result]) => {
            if (result.harness !== harness) return
            const catalogue = result.entries
            if (props.model || !props.recommendedTier || !catalogue.length)
                return
            const candidate =
                props.environment.modelTiers[
                    harness as keyof typeof props.environment.modelTiers
                ]?.[props.recommendedTier]
            if (candidate && catalogue.some((entry) => entry.id === candidate))
                props.setModel(candidate)
        },
    )
    return (
        <div class="mt-5 grid gap-4">
            <Show when={props.setMachine && props.environment.machines.length}>
                <label class="field">
                    <span>Machine</span>
                    <select
                        value={props.machine ?? ""}
                        onChange={(event) => {
                            const machine = event.currentTarget.value
                            props.setMachine!(machine)
                            // Keep the agent if it can run there too; a model
                            // list is per harness, so only reset it on a switch.
                            if (
                                !usableHarnesses(
                                    props.environment,
                                    machine,
                                ).some((item) => item.id === props.harness)
                            ) {
                                props.setHarness(
                                    defaultHarness(props.environment, machine),
                                )
                                props.setModel("")
                            }
                        }}>
                        <option value="">This computer</option>
                        <For each={props.environment.machines}>
                            {(item) => (
                                <option value={item.id}>{item.label}</option>
                            )}
                        </For>
                    </select>
                </label>
            </Show>
            <fieldset class="grid min-w-0 gap-2">
                <legend class="label">Agent</legend>
                <div class="grid grid-cols-[repeat(auto-fit,minmax(8rem,1fr))] gap-3">
                    <For each={available()}>
                        {(item) => (
                            <label class="choice grid min-h-17 grid-cols-[1.5rem_1fr] items-center gap-2 p-3">
                                <input
                                    type="radio"
                                    name={`${radioGroup}-harness`}
                                    value={item.id}
                                    checked={
                                        latest(() => props.harness) === item.id
                                    }
                                    onChange={() => {
                                        props.setHarness(item.id)
                                        props.setModel("")
                                    }}
                                />
                                <img
                                    class={`h-6 w-6 object-contain ${
                                        item.id === "codex" ? "invert" : ""
                                    }`}
                                    src={
                                        item.id === "claude"
                                            ? claudeIcon
                                            : item.id === "pi"
                                              ? piIcon
                                              : codexIcon
                                    }
                                    alt=""
                                />
                                <strong>{item.label}</strong>
                            </label>
                        )}
                    </For>
                </div>
            </fieldset>
            <Loading
                fallback={
                    <ModelPicker
                        harness={props.harness}
                        models={[]}
                        value=""
                        setValue={props.setModel}
                        defaultLabel={defaultLabel()}
                        recommended={props.perTaskModel ?? props.unattended}
                        busy
                    />
                }>
                <ModelPicker
                    harness={props.harness}
                    models={isPending(models) ? [] : models().entries}
                    busy={isPending(models)}
                    value={props.model}
                    setValue={props.setModel}
                    defaultLabel={defaultLabel()}
                    recommended={props.perTaskModel ?? props.unattended}
                />
            </Loading>
            <div class="grid items-start gap-4 sm:grid-cols-[repeat(auto-fit,minmax(14rem,1fr))]">
                <Show when={!props.unattended}>
                    <fieldset class="grid min-w-0 gap-2">
                        <legend class="label">Run mode</legend>
                        <div class="flex flex-wrap gap-2">
                            <label class="choice compact">
                                <input
                                    type="radio"
                                    name={`${radioGroup}-mode`}
                                    value="terminal"
                                    checked={props.mode === "terminal"}
                                    disabled={
                                        !props.environment.terminalAvailable
                                    }
                                    onChange={() => props.setMode("terminal")}
                                />
                                <span>Interactive terminal</span>
                            </label>
                            <label class="choice compact">
                                <input
                                    type="radio"
                                    name={`${radioGroup}-mode`}
                                    value="print"
                                    checked={props.mode === "print"}
                                    onChange={() => props.setMode("print")}
                                />
                                <span>Headless log</span>
                            </label>
                        </div>
                    </fieldset>
                </Show>
                <fieldset class="grid min-w-0 gap-2">
                    <legend class="label">Permissions</legend>
                    <div class="flex flex-wrap gap-2">
                        <For
                            each={Object.entries(AGENT_PERMISSION_MODE_LABELS)}>
                            {([value, label]) => (
                                <label class="choice compact">
                                    <input
                                        type="radio"
                                        name={`${radioGroup}-permission`}
                                        value={value}
                                        checked={
                                            (props.unattended &&
                                            props.permission === "manual"
                                                ? "bypassPermissions"
                                                : props.permission) === value
                                        }
                                        onChange={() =>
                                            props.setPermission(
                                                value as AgentPermissionMode,
                                            )
                                        }
                                    />
                                    <span>{label}</span>
                                </label>
                            )}
                        </For>
                    </div>
                </fieldset>
            </div>
        </div>
    )
}
