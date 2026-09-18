import { For, Show, createSignal, type Element } from "solid-js"
import {
    BranchIcon,
    InvestigationIcon,
    PlusIcon,
    RunIcon,
} from "../components/icons"

export type NewTabKind = "investigation" | "branch" | "run"

const CHOICES: {
    kind: NewTabKind
    title: string
    detail: string
    Icon: () => Element
}[] = [
    {
        kind: "investigation",
        Icon: InvestigationIcon,
        title: "Investigation",
        detail: "A question for an agent to research into tasks.",
    },
    {
        kind: "branch",
        Icon: BranchIcon,
        title: "Branch",
        detail: "A branch to deliver some of the tasks through.",
    },
    {
        kind: "run",
        Icon: RunIcon,
        title: "Run",
        detail: "An agent working through the tasks.",
    },
]

/** The "+" at the end of the tab bar. */
export function AddTabMenu(props: {
    choose: (kind: NewTabKind) => void
    busy: boolean
    /** Kinds that cannot be added right now, with why. */
    unavailable?: Partial<Record<NewTabKind, string>>
}) {
    const [open, setOpen] = createSignal(false)
    return (
        <div
            class="relative self-center"
            onFocusOut={(event) => {
                // Removing the focused menu item fires this mid-render, when a
                // write is not allowed — and the menu is already closed then.
                if (
                    !open() ||
                    event.currentTarget.contains(event.relatedTarget as Node)
                )
                    return
                queueMicrotask(() => setOpen(false))
            }}
            onKeyDown={(event) => {
                if (event.key === "Escape") setOpen(false)
            }}>
            <button
                type="button"
                class="inline-flex items-center gap-1 px-2 py-1"
                aria-haspopup="menu"
                aria-expanded={open() ? "true" : "false"}
                aria-busy={props.busy ? "true" : "false"}
                disabled={props.busy}
                title="Add a tab"
                onClick={() => setOpen(!open())}>
                <PlusIcon />
                <span class="sr-only">Add a tab</span>
            </button>
            <Show when={open()}>
                <div
                    role="menu"
                    class="menu absolute z-[10] top-[calc(100%_+_0.3rem)] left-0 w-[18rem] p-[0.3rem]">
                    <For each={CHOICES}>
                        {(choice) => (
                            <button
                                type="button"
                                role="menuitem"
                                class="option block w-full p-[0.6rem_0.65rem] text-left"
                                disabled={!!props.unavailable?.[choice.kind]}
                                title={props.unavailable?.[choice.kind]}
                                onClick={() => {
                                    setOpen(false)
                                    props.choose(choice.kind)
                                }}>
                                <strong class="flex items-center gap-[0.4rem] text-sm">
                                    <choice.Icon />
                                    {choice.title}
                                </strong>
                                <span class="caption muted block">
                                    {props.unavailable?.[choice.kind] ??
                                        choice.detail}
                                </span>
                            </button>
                        )}
                    </For>
                </div>
            </Show>
        </div>
    )
}
