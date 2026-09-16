import type { Element } from "solid-js"
import styles from "./Modal.module.css"

export function Modal(props: {
    title: string
    close: () => void
    children: Element
}) {
    return (
        <div
            class={`${styles.scope} modal-scrim fixed inset-0 z-50 grid place-items-center p-4`}
            onMouseDown={(event) =>
                event.currentTarget === event.target && props.close()
            }
        >
            <section
                class="modal-panel max-h-[92vh] w-full max-w-2xl overflow-auto bg-white p-6"
                role="dialog"
                aria-modal="true"
            >
                <header class="mb-5 flex items-center justify-between gap-4">
                    <h2 class="text-xl font-semibold tracking-tight">
                        {props.title}
                    </h2>
                    <button
                        class="button inline-flex min-h-[2.5rem] items-center justify-center gap-[0.45rem] p-[0.5rem_0.9rem]"
                        onClick={props.close}
                    >
                        Close
                    </button>
                </header>
                {props.children}
            </section>
        </div>
    )
}
