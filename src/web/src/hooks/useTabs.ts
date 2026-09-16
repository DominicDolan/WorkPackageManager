import { createEffect, createSignal, onCleanup, untrack } from "solid-js"

let nextTabsId = 0

/** Plain button tabs with roving focus and matching panel attributes. */
export function useTabs<T extends string | number>(initial: T | (() => T)) {
    const id = `tabs-${++nextTabsId}`
    const [selected, setSelected] = createSignal<T | undefined>(undefined)
    const activeTab = (): T =>
        selected() ?? (typeof initial === "function" ? initial() : initial)
    const setActiveTab = (value: T) => setSelected(() => value)
    const matches = (value: T) => activeTab() === value
    const key = (value: T) => encodeURIComponent(String(value))
    const tabProps = (value: T) => {
        let element: HTMLButtonElement | undefined
        const update = (selected: boolean) => {
            if (!element) return
            element.setAttribute("aria-selected", String(selected))
            element.tabIndex = selected ? 0 : -1
        }
        // Ref factories run in an owned scope; the returned ref only attaches.
        createEffect(() => matches(value), update)
        const onClick = () => setActiveTab(value)
        const onKeyDown = (event: KeyboardEvent) => {
            const target = event.currentTarget as HTMLButtonElement
            const list = target.closest('[role="tablist"]')
            if (!list) return
            const tabs = Array.from(
                list.querySelectorAll<HTMLButtonElement>(
                    '[role="tab"]:not(:disabled)',
                ),
            )
            const index = tabs.indexOf(target)
            const vertical =
                list.getAttribute("aria-orientation") === "vertical"
            const previous = vertical ? "ArrowUp" : "ArrowLeft"
            const next = vertical ? "ArrowDown" : "ArrowRight"
            const destination =
                event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? tabs.length - 1
                      : event.key === next
                        ? (index + 1) % tabs.length
                        : event.key === previous
                          ? (index + tabs.length - 1) % tabs.length
                          : -1
            if (destination < 0) return
            event.preventDefault()
            tabs[destination]?.focus()
            tabs[destination]?.click()
        }
        const detach = () => {
            element?.removeEventListener("click", onClick)
            element?.removeEventListener("keydown", onKeyDown)
            element = undefined
        }
        onCleanup(detach)
        return (button: HTMLButtonElement) => {
            detach()
            element = button
            button.type = "button"
            button.setAttribute("role", "tab")
            button.id = `${id}-tab-${key(value)}`
            button.setAttribute("aria-controls", `${id}-panel-${key(value)}`)
            update(untrack(() => matches(value)))
            button.addEventListener("click", onClick)
            button.addEventListener("keydown", onKeyDown)
        }
    }
    const windowProps = (value: T) => ({
        role: "tabpanel" as const,
        id: `${id}-panel-${key(value)}`,
        "aria-labelledby": `${id}-tab-${key(value)}`,
        tabindex: 0,
        get hidden() {
            return !matches(value)
        },
    })
    return { activeTab, setActiveTab, matches, tabProps, windowProps }
}
