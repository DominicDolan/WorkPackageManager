import { Show } from "solid-js"
import styles from "./Brand.module.css"

export function Brand(props: { compact?: boolean }) {
  return (
    <div
      class={`${styles.scope} brand ${props.compact ? "brand-compact" : ""}`}
    >
      <svg class="brand-mark" viewBox="0 0 36 36" aria-hidden="true">
        <path d="M7 5h15v5H12v16h10v5H7z" />
        <path class="brand-signal" d="M19 14h10v10H19z" />
      </svg>
      <Show when={!props.compact}>
        <span class="brand-name">Worktask</span>
      </Show>
    </div>
  )
}
