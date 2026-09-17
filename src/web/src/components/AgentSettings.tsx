import {
    AGENT_PERMISSION_MODE_LABELS,
    type AgentEnvironment,
    type AgentPermissionMode,
    type AgentRunMode,
    type ModelTier,
} from "@shared/types"
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
import { ModelPicker } from "./ModelPicker"

export function AgentSettings(props: {
    environment: AgentEnvironment
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
}) {
    const available = () =>
        props.environment.harnesses.filter((item) => item.available)
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
        <div class="mt-5 grid gap-4 sm:grid-cols-2">
            <label class="field">
                <span>Agent</span>
                <select
                    value={latest(() => props.harness)}
                    onChange={(event) => {
                        props.setHarness(event.currentTarget.value)
                        props.setModel("")
                    }}>
                    <For each={available()}>
                        {(item) => (
                            <option value={item.id}>{item.label}</option>
                        )}
                    </For>
                </select>
            </label>
            <Loading
                fallback={
                    <ModelPicker
                        models={[]}
                        value=""
                        setValue={props.setModel}
                        defaultLabel={defaultLabel()}
                        busy
                    />
                }>
                <ModelPicker
                    models={isPending(models) ? [] : models().entries}
                    busy={isPending(models)}
                    value={props.model}
                    setValue={props.setModel}
                    defaultLabel={defaultLabel()}
                />
            </Loading>
            <Show when={!props.unattended}>
                <label class="field">
                    <span>Run mode</span>
                    <select
                        value={props.mode}
                        onChange={(event) =>
                            props.setMode(
                                event.currentTarget.value as AgentRunMode,
                            )
                        }>
                        <option
                            value="terminal"
                            disabled={!props.environment.terminalAvailable}>
                            Interactive terminal
                        </option>
                        <option value="print">Headless log</option>
                    </select>
                </label>
            </Show>
            <label class="field">
                <span>Permissions</span>
                <select
                    value={
                        props.unattended && props.permission === "manual"
                            ? "bypassPermissions"
                            : props.permission
                    }
                    onChange={(event) =>
                        props.setPermission(
                            event.currentTarget.value as AgentPermissionMode,
                        )
                    }>
                    <For each={Object.entries(AGENT_PERMISSION_MODE_LABELS)}>
                        {([value, label]) => (
                            <option value={value}>{label}</option>
                        )}
                    </For>
                </select>
            </label>
        </div>
    )
}
