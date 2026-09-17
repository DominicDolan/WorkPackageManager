import type { Element } from "solid-js"

export function InfoCard(props: { title: string; children: Element }) {
    return (
        <article class="summary p-[1.2rem]">
            <h3 class="m-[0_0_1rem] pb-[0.75rem]">{props.title}</h3>
            {props.children}
        </article>
    )
}
