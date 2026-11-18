import { RECOMMENDED_MODEL, type AgentModel } from "@work-task-manager/shared"
import { For, Show, createEffect, createSignal } from "solid-js"

const RECENT_MODELS_KEY = "work-task-manager.recent-agent-models"
const MAX_RECENT_MODELS = 5

type RecentModels = Record<string, string[]>

function readRecentModels(harness: string): string[] {
    try {
        const saved = JSON.parse(
            localStorage.getItem(RECENT_MODELS_KEY) ?? "{}",
        ) as RecentModels
        return saved[harness] ?? []
    } catch {
        return []
    }
}

function saveRecentModel(harness: string, model: string) {
    if (!model || model === RECOMMENDED_MODEL) return
    try {
        const saved = JSON.parse(
            localStorage.getItem(RECENT_MODELS_KEY) ?? "{}",
        ) as RecentModels
        saved[harness] = [
            model,
            ...(saved[harness] ?? []).filter((id) => id !== model),
        ].slice(0, MAX_RECENT_MODELS)
        localStorage.setItem(RECENT_MODELS_KEY, JSON.stringify(saved))
    } catch {
        // A blocked or full storage area should never prevent launching an agent.
    }
}

export function ModelPicker(props: {
    harness: string
    models: AgentModel[]
    value: string
    setValue: (value: string) => void
    defaultLabel: string
    recommended?: boolean
    busy?: boolean
}) {
    const [recent, setRecent] = createSignal<string[]>([])
    const [open, setOpen] = createSignal(false)
    const [query, setQuery] = createSignal("")
    const radioName = `agent-model-${Math.random().toString(36).slice(2)}`
    createEffect(
        () => props.harness,
        (harness) => {
            setRecent(readRecentModels(harness))
            setOpen(false)
            setQuery("")
        },
    )
    createEffect(
        () => [props.busy, props.value, props.harness] as const,
        ([busy, value, harness]) => {
            if (busy) {
                setOpen(false)
                setQuery("")
            }
            if (value) {
                saveRecentModel(harness, value)
                setRecent(readRecentModels(harness))
            }
        },
    )
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
        if (props.busy) return
        props.setValue(entry?.id ?? "")
        if (entry) {
            saveRecentModel(props.harness, entry.id)
            setRecent(readRecentModels(props.harness))
        }
        setOpen(false)
        setQuery("")
    }
    const recentChoices = () => {
        const ids = [...new Set([props.value, ...recent()].filter(Boolean))]
        return ids
            .map((id) => props.models.find((item) => item.id === id))
            .filter((item): item is AgentModel => !!item)
    }
    return (
        <fieldset
            class="grid min-w-0 gap-2"
            aria-busy={props.busy ? "true" : "false"}>
            <legend class="label">Model</legend>
            <div class="flex flex-wrap gap-2">
                <Show when={props.recommended}>
                    <label class="choice compact">
                        <input
                            type="radio"
                            name={radioName}
                            checked={props.value === RECOMMENDED_MODEL}
                            disabled={props.busy}
                            onChange={() =>
                                choose({
                                    id: RECOMMENDED_MODEL,
                                    label: "Recommended for each task",
                                    group: null,
                                })
                            }
                        />
                        <span>Recommended for each task</span>
                    </label>
                </Show>
                <label class="choice compact">
                    <input
                        type="radio"
                        name={radioName}
                        checked={!props.value}
                        disabled={props.busy}
                        onChange={() => choose()}
                    />
                    <span>{props.defaultLabel}</span>
                </label>
                <For each={recentChoices()}>
                    {(entry) => (
                        <label class="choice compact">
                            <input
                                type="radio"
                                name={radioName}
                                checked={props.value === entry.id}
                                disabled={props.busy}
                                onChange={() => choose(entry)}
                            />
                            <span>{entry.label}</span>
                        </label>
                    )}
                </For>
                <div class="relative">
                    <button
                        type="button"
                        class="outlined min-h-9 border-dashed px-2 py-1 text-xs"
                        disabled={props.busy}
                        aria-expanded={open() ? "true" : "false"}
                        onClick={() => {
                            setOpen(!open())
                        }}>
                        <span aria-hidden="true" class="text-base leading-3">
                            +
                        </span>{" "}
                        Add model
                    </button>
                    <Show when={open() && !props.busy}>
                        <div class="menu absolute top-[calc(100%+0.3rem)] left-0 z-20 w-[min(22rem,calc(100vw-4rem))] p-1">
                            <input
                                role="combobox"
                                aria-label="Search models"
                                aria-expanded="true"
                                value={query()}
                                placeholder="Search models…"
                                autofocus
                                onInput={(event) =>
                                    setQuery(event.currentTarget.value)
                                }
                                onKeyDown={(event) => {
                                    if (event.key === "Escape") setOpen(false)
                                }}
                            />
                            <div class="max-h-56 overflow-auto p-1">
                                <For
                                    each={filtered()}
                                    fallback={
                                        <p class="px-3 py-5 text-center caption muted">
                                            No matching models.
                                        </p>
                                    }>
                                    {(entry) => (
                                        <button
                                            type="button"
                                            class="option flex w-full items-center justify-between gap-[1rem] p-[0.6rem_0.75rem]"
                                            onClick={() => choose(entry)}>
                                            <span class="truncate">
                                                {entry.label}
                                            </span>
                                            <small class="flex-none">
                                                {entry.group ?? entry.id}
                                            </small>
                                        </button>
                                    )}
                                </For>
                            </div>
                        </div>
                    </Show>
                </div>
            </div>
        </fieldset>
    )
}
