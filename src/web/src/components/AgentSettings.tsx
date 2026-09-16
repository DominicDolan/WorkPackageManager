import { For, Show, createEffect, createSignal, onSettled } from "solid-js"
import {
    AGENT_PERMISSION_MODE_LABELS,
    type AgentEnvironment,
    type AgentModel,
    type AgentPermissionMode,
    type AgentRunMode,
    type ModelTier,
} from "@shared/types"
import { api } from "../api"
import styles from "./AgentSettings.module.css"

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
        <div class={`${styles.scope} mt-5 grid gap-4 sm:grid-cols-2`}>
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

function ModelPicker(props: {
    models: AgentModel[]
    value: string
    setValue: (value: string) => void
    defaultLabel: string
}) {
    // The empty id means "use this harness's default". Do not borrow the label
    // from the last model response: while a new harness's models load, that can
    // briefly (and misleadingly) describe the previously selected harness.
    const selected = () =>
        props.value
            ? props.models.find((item) => item.id === props.value)
            : undefined
    const [query, setQuery] = createSignal("")
    const [open, setOpen] = createSignal(false)
    let picker: HTMLLabelElement | undefined
    const filtered = () => {
        const needle = query().trim().toLowerCase()
        const choices = props.models.filter((item) => item.id)
        return (
            needle
                ? choices.filter((item) =>
                      `${item.label} ${item.id} ${item.group ?? ""}`
                          .toLowerCase()
                          .includes(needle),
                  )
                : choices
        ).slice(0, 80)
    }
    const choose = (entry?: AgentModel) => {
        props.setValue(entry?.id ?? "")
        setQuery(entry?.label ?? "")
        setOpen(false)
    }
    onSettled(() => {
        const dismiss = (event: PointerEvent) => {
            if (picker && !picker.contains(event.target as Node)) setOpen(false)
        }
        document.addEventListener("pointerdown", dismiss)
        return () => document.removeEventListener("pointerdown", dismiss)
    })
    return (
        <label ref={picker} class="field relative">
            <span>Model</span>
            <input
                role="combobox"
                aria-expanded={open() ? "true" : "false"}
                value={
                    open() ? query() : (selected()?.label ?? props.defaultLabel)
                }
                placeholder={
                    props.models.length ? "Search models…" : "Harness default"
                }
                onFocus={() => {
                    setQuery(selected()?.label ?? "")
                    setOpen(true)
                }}
                onInput={(event) => {
                    setQuery(event.currentTarget.value)
                    setOpen(true)
                    if (!event.currentTarget.value) props.setValue("")
                }}
                onKeyDown={(event) => {
                    if (event.key === "Escape") setOpen(false)
                }}
            />
            <Show when={open()}>
                <div class="absolute left-0 right-0 top-full z-20 mt-1 max-h-64 overflow-auto rounded-xl border border-slate-200 bg-white p-1 shadow-2xl">
                    <button
                        type="button"
                        class="model-option"
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => choose()}
                    >
                        <span>{props.defaultLabel}</span>
                    </button>
                    <For
                        each={filtered()}
                        fallback={
                            <p class="px-3 py-5 text-center text-xs text-slate-500">
                                No matching models.
                            </p>
                        }
                    >
                        {(entry) => (
                            <button
                                type="button"
                                class="model-option"
                                onMouseDown={(event) => event.preventDefault()}
                                onClick={() => choose(entry)}
                            >
                                <span class="truncate">{entry.label}</span>
                                <small>{entry.group ?? entry.id}</small>
                            </button>
                        )}
                    </For>
                </div>
            </Show>
        </label>
    )
}
