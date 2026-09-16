import { render } from "@solidjs/web"
import {
    createContext,
    getOwner,
    onCleanup,
    runWithOwner,
    type Element,
} from "solid-js"

export const DialogContext = createContext<HTMLDialogElement | null>(null)

export interface DialogOptions {
    id?: string
    label?: string
    closedby?: "any" | "closerequest" | "none"
    popover?: false | "auto" | "manual"
    onClose?: (returnValue: string) => void
}

/** Lazily mounts fresh content on each open, owned by the calling component. */
export function useDialog(
    content: (controls: {
        closeDialog: (returnValue?: string) => void
    }) => Element,
    options: DialogOptions = {},
) {
    const owner = getOwner()
    let current: { element: HTMLDialogElement; dispose: () => void } | undefined
    let disposed = false

    const cleanup = (notify: boolean) => {
        const instance = current
        if (!instance) return
        current = undefined
        const value = instance.element.returnValue
        if (options.popover) instance.element.hidePopover()
        else if (instance.element.open) instance.element.close()
        instance.dispose()
        instance.element.remove()
        if (notify) options.onClose?.(value)
    }
    const closeDialog = (returnValue = "") => {
        if (!current) return
        current.element.returnValue = returnValue
        cleanup(true)
    }
    const openDialog = () => {
        if (disposed || current) return
        const element = document.createElement("dialog")
        if (options.id) element.id = options.id
        element.setAttribute("aria-label", options.label ?? "Dialog")
        element.setAttribute("closedby", options.closedby ?? "closerequest")
        if (options.popover) element.setAttribute("popover", options.popover)
        const instance = { element, dispose: () => {} }
        current = instance
        element.addEventListener("close", () => {
            if (current === instance) cleanup(true)
        })
        element.addEventListener("cancel", (event) => {
            // Also enforce closedby in browsers that do not yet implement it.
            event.preventDefault()
            if (options.closedby !== "none") closeDialog()
        })
        element.addEventListener("click", (event) => {
            if (options.closedby !== "any" || event.target !== element) return
            const bounds = element.getBoundingClientRect()
            if (
                event.clientX < bounds.left ||
                event.clientX > bounds.right ||
                event.clientY < bounds.top ||
                event.clientY > bounds.bottom
            )
                closeDialog()
        })
        element.addEventListener("toggle", (event) => {
            if (
                options.popover &&
                event.newState === "closed" &&
                current === instance
            )
                cleanup(true)
        })
        document.body.append(element)
        try {
            instance.dispose = runWithOwner(owner, () =>
                render(
                    () => (
                        <DialogContext value={element}>
                            {content({ closeDialog })}
                        </DialogContext>
                    ),
                    element,
                ),
            )
            if (options.popover) element.showPopover()
            else element.showModal()
        } catch (error) {
            cleanup(false)
            throw error
        }
    }
    onCleanup(() => {
        disposed = true
        cleanup(false)
    })
    return { openDialog, closeDialog }
}
