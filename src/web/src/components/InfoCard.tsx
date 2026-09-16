import type { Element } from "solid-js"

export function InfoCard(props: { title: string; children: Element }) {
    return (
        <article class="summary p-[1.2rem] [&>h3]:m-[0_0_1rem] [&>h3]:pb-[0.75rem]">
            <h3>{props.title}</h3>
            {props.children}
        </article>
    )
}
