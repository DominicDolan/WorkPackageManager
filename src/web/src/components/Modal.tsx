import { createEffect, onSettled, useContext, type Element } from "solid-js"
import { DialogContext, useDialog } from "../hooks/useDialog"

export function Modal(props: {
    title: string
    close: () => void
    children: Element
}) {
    const host = useContext(DialogContext)
    const content = () => (
        <section class="content max-h-[92vh] w-full max-w-2xl overflow-auto p-6">
            <header class="mb-5 flex items-center justify-between gap-4">
                <h2>{props.title}</h2>
                <button class="outlined" onClick={props.close}>
                    Close
                </button>
            </header>
            {props.children}
        </section>
    )
    if (host) {
        createEffect(
            () => props.title,
            (title) => host.setAttribute("aria-label", title),
        )
        return content()
    }
    const { openDialog } = useDialog(content, {
        label: props.title,
        closedby: "any",
        onClose: props.close,
    })
    // render() flushes; defer opening until Solid's current flush has ended.
    onSettled(() => queueMicrotask(openDialog))
    return null
}
