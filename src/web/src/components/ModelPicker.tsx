import { type AgentModel } from "@shared/types"
import { For, Show, createEffect, createSignal, onSettled } from "solid-js"

export function ModelPicker(props: {
    models: AgentModel[]
    value: string
    setValue: (value: string) => void
    defaultLabel: string
    busy?: boolean
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
    createEffect(
        () => props.busy,
        (busy) => {
            if (busy) {
                setOpen(false)
                setQuery("")
            }
        },
    )
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
        if (props.busy) return
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
                disabled={props.busy}
                aria-busy={props.busy ? "true" : "false"}
                aria-expanded={open() && !props.busy ? "true" : "false"}
                value={
                    open() && !props.busy
                        ? query()
                        : (selected()?.label ?? props.defaultLabel)
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
            <Show when={open() && !props.busy}>
                <div class="menu absolute left-0 right-0 top-full z-20 mt-1 max-h-64 overflow-auto p-1">
                    <button
                        type="button"
                        class="option flex w-full items-center justify-between gap-[1rem] p-[0.6rem_0.75rem] [&_small]:flex-none"
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => choose()}>
                        <span>{props.defaultLabel}</span>
                    </button>
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
                                class="option flex w-full items-center justify-between gap-[1rem] p-[0.6rem_0.75rem] [&_small]:flex-none"
                                onMouseDown={(event) => event.preventDefault()}
                                onClick={() => choose(entry)}>
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
