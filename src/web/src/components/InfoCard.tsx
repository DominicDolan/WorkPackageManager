import type { Element } from "solid-js"
import styles from "./InfoCard.module.css"

export function InfoCard(props: { title: string; children: Element }) {
    return (
        <section
            class={`${styles.scope} info-panel p-[1.2rem] [&>h3]:m-[0_0_1rem] [&>h3]:pb-[0.75rem]`}
        >
            <h3>{props.title}</h3>
            {props.children}
        </section>
    )
}
