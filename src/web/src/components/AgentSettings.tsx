import {
    AGENT_PERMISSION_MODE_LABELS,
    type AgentEnvironment,
    type AgentModel,
    type AgentPermissionMode,
    type AgentRunMode,
    type ModelTier,
} from "@shared/types"
import { For, Show, createEffect, createSignal } from "solid-js"
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
        props.environment.harnesses.find((item) => item.id === props.harness)
    const [models, setModels] = createSignal<AgentModel[]>([])
    // A model catalogue belongs to one harness. Keeping that request here lets us
    // clear the previous catalogue immediately and ignore a late response from a
    // harness the person has since switched away from.
    createEffect(
        () => props.harness,
        (harness) => {
            let current = true
            setModels([])
            if (harness) {
                api.agentModels(harness)
                    .then((entries) => {
                        if (current) setModels(entries)
                    })
                    .catch(() => {
                        if (current) setModels([])
                    })
            }
            return () => {
                current = false
            }
        },
    )
    // A recommendation is a starting point, not a restriction. Resolve it only
    // after this harness's catalogue arrives; a user choosing the harness default
    // later leaves the value empty and is not overwritten.
    createEffect(
        () => [props.harness, models()] as const,
        ([harness, catalogue]) => {
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
                    value={props.harness}
                    onChange={(event) => {
                        props.setHarness(event.currentTarget.value)
                        props.setModel("")
                    }}
                >
                    <For each={available()}>
                        {(item) => (
                            <option value={item.id}>{item.label}</option>
                        )}
                    </For>
                </select>
            </label>
            <ModelPicker
                models={models()}
                value={props.model}
                setValue={props.setModel}
                defaultLabel={
                    selectedHarness()
                        ? `Default (${selectedHarness()!.label}'s configured model)`
                        : "Harness default"
                }
            />
            <Show when={!props.unattended}>
                <label class="field">
                    <span>Run mode</span>
                    <select
                        value={props.mode}
                        onChange={(event) =>
                            props.setMode(
                                event.currentTarget.value as AgentRunMode,
                            )
                        }
                    >
                        <option
                            value="terminal"
                            disabled={!props.environment.terminalAvailable}
                        >
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
                    }
                >
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
