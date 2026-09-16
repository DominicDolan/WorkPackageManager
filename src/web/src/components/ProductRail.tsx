import { Show } from "solid-js"
import type { MainView } from "../types/navigation"
import { Brand } from "./Brand"
import styles from "./ProductRail.module.css"

export function ProductRail(props: {
    active: MainView
    select: (view: MainView) => void
}) {
    return (
        <aside
            class={`${styles.scope} product-rail sticky top-0 flex h-[100vh] flex-col p-[1.75rem_1.5rem] overflow-hidden after:absolute after:right-[-5rem] after:bottom-[5rem] after:w-[11rem] after:h-[11rem] max-[820px]:relative max-[820px]:w-auto max-[820px]:h-auto max-[820px]:min-h-[4rem] max-[820px]:flex-row max-[820px]:items-center max-[820px]:justify-between max-[820px]:p-[1rem_1.25rem] max-[820px]:after:hidden`}
        >
            <Brand />
            <nav
                class="rail-nav m-[4.5rem_-1.5rem_0] max-[820px]:m-0"
                aria-label="Primary navigation"
            >
                <button
                    class={`rail-link ${props.active === "work-packages" ? "rail-link-active" : ""} relative flex min-h-[2.8rem] items-center gap-[0.75rem] p-[0_1.5rem] w-full max-[820px]:min-h-[2rem] max-[820px]:p-[0_0_0_1rem]`}
                    aria-current={
                        props.active === "work-packages" ? "page" : undefined
                    }
                    onClick={() => props.select("work-packages")}
                >
                    <Show when={props.active === "work-packages"}>
                        <span class="rail-indicator absolute [inset-block:0] left-0 w-[3px]" />
                    </Show>
                    Work packages
                </button>
                <button
                    class={`rail-link ${props.active === "notes" ? "rail-link-active" : ""} relative flex min-h-[2.8rem] items-center gap-[0.75rem] p-[0_1.5rem] w-full max-[820px]:min-h-[2rem] max-[820px]:p-[0_0_0_1rem]`}
                    aria-current={props.active === "notes" ? "page" : undefined}
                    onClick={() => props.select("notes")}
                >
                    <Show when={props.active === "notes"}>
                        <span class="rail-indicator absolute [inset-block:0] left-0 w-[3px]" />
                    </Show>
                    Notes
                </button>
                <button
                    class={`rail-link ${props.active === "issues" ? "rail-link-active" : ""} relative flex min-h-[2.8rem] items-center gap-[0.75rem] p-[0_1.5rem] w-full max-[820px]:min-h-[2rem] max-[820px]:p-[0_0_0_1rem]`}
                    aria-current={
                        props.active === "issues" ? "page" : undefined
                    }
                    onClick={() => props.select("issues")}
                >
                    <Show when={props.active === "issues"}>
                        <span class="rail-indicator absolute [inset-block:0] left-0 w-[3px]" />
                    </Show>
                    Issues
                </button>
            </nav>
            <div class="rail-note relative z-[1] mt-auto pt-[1rem] [&_p]:m-[0.55rem_0_0] max-[820px]:hidden">
                <span>Workspace flow</span>
                <p>
                    Investigate.
                    <br />
                    Build. Verify. Ship.
                </p>
            </div>
            <p class="rail-version relative z-[1] m-[1.5rem_0_0] max-[820px]:hidden">
                Local workspace
            </p>
        </aside>
    )
}
