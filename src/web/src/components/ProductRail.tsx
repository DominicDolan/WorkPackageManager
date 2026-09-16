import { Show } from "solid-js"
import type { MainView } from "../types/navigation"
import { Brand } from "./Brand"
import styles from "./ProductRail.module.css"

export function ProductRail(props: {
    active: MainView
    select: (view: MainView) => void
}) {
    return (
        <aside class={`${styles.scope} product-rail`}>
            <Brand />
            <nav class="rail-nav" aria-label="Primary navigation">
                <button
                    class={`rail-link ${props.active === "work-packages" ? "rail-link-active" : ""}`}
                    aria-current={
                        props.active === "work-packages" ? "page" : undefined
                    }
                    onClick={() => props.select("work-packages")}
                >
                    <Show when={props.active === "work-packages"}>
                        <span class="rail-indicator" />
                    </Show>
                    Work packages
                </button>
                <button
                    class={`rail-link ${props.active === "notes" ? "rail-link-active" : ""}`}
                    aria-current={props.active === "notes" ? "page" : undefined}
                    onClick={() => props.select("notes")}
                >
                    <Show when={props.active === "notes"}>
                        <span class="rail-indicator" />
                    </Show>
                    Notes
                </button>
                <button
                    class={`rail-link ${props.active === "issues" ? "rail-link-active" : ""}`}
                    aria-current={
                        props.active === "issues" ? "page" : undefined
                    }
                    onClick={() => props.select("issues")}
                >
                    <Show when={props.active === "issues"}>
                        <span class="rail-indicator" />
                    </Show>
                    Issues
                </button>
            </nav>
            <div class="rail-note">
                <span>Workspace flow</span>
                <p>
                    Investigate.
                    <br />
                    Build. Verify. Ship.
                </p>
            </div>
            <p class="rail-version">Local workspace</p>
        </aside>
    )
}
