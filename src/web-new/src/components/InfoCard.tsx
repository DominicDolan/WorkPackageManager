import type { Element } from "solid-js"
import styles from "./InfoCard.module.css"

export function InfoCard(props: { title: string; children: Element }) {
  return (
    <section class={`${styles.scope} info-panel`}>
      <h3>{props.title}</h3>
      {props.children}
    </section>
  )
}
