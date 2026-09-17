import { ISSUE_SOURCE_LABELS, type IssueDetail } from "@shared/types"
import { Show, createSignal } from "solid-js"
import { BackIcon } from "../components/icons"

export function IssueDetailPane(props: {
    issue: IssueDetail
    back: () => void
}) {
    const [raw, setRaw] = createSignal(false)
    return (
        <article class="document max-w-[980px] p-[clamp(1.25rem,_3vw,_3rem)] max-w-[1100px]">
            <button
                class="back inline-flex items-center gap-[0.35rem] mb-[1.4rem]"
                onClick={props.back}>
                <BackIcon />
                All issues
            </button>
            <header class="flex items-start justify-between gap-[1rem] pb-[1.25rem] max-[560px]:block">
                <div>
                    <span class="badge info inline-flex mr-[0.45rem] p-[0.15rem_0.42rem]">
                        {ISSUE_SOURCE_LABELS[props.issue.source] ??
                            props.issue.source}
                    </span>
                    <span class="reference">{props.issue.key}</span>
                    <h2 class="max-w-[25ch] m-[0.4rem_0_0]">
                        {props.issue.title}
                    </h2>
                </div>
                <Show when={props.issue.url}>
                    {(url) => (
                        <a
                            class="primary max-[560px]:mt-[1rem]"
                            href={url()}
                            target="_blank"
                            rel="noreferrer">
                            Open source
                        </a>
                    )}
                </Show>
            </header>
            <dl class="properties grid grid-cols-[repeat(2,_minmax(0,_1fr))] gap-[1px] m-[1.5rem_0] max-[560px]:grid-cols-[1fr]">
                <div class="p-[0.8rem]">
                    <dt>State</dt>
                    <dd class="m-[0.25rem_0_0]">{props.issue.stateLabel}</dd>
                </div>
                <div class="p-[0.8rem]">
                    <dt>Assigned</dt>
                    <dd class="m-[0.25rem_0_0]">
                        {props.issue.assignees
                            .map((person) => person.name)
                            .join(", ") || "Unassigned"}
                    </dd>
                </div>
                <div class="p-[0.8rem]">
                    <dt>Updated</dt>
                    <dd class="m-[0.25rem_0_0]">
                        {props.issue.updatedAt
                            ? new Date(
                                  props.issue.updatedAt,
                              ).toLocaleDateString()
                            : "—"}
                    </dd>
                </div>
                <div class="p-[0.8rem]">
                    <dt>Comments</dt>
                    <dd class="m-[0.25rem_0_0]">
                        {props.issue.commentCount ?? "—"}
                    </dd>
                </div>
            </dl>
            <section class="content m-[1.5rem_0]">
                <h3>Description</h3>
                <pre class="overflow-auto p-[1rem]">
                    {props.issue.body || "No description."}
                </pre>
            </section>
            <button class="outlined" onClick={() => setRaw(!raw())}>
                {raw() ? "Hide raw JSON" : "Show raw JSON"}
            </button>
            <Show when={raw()}>
                <pre class="overflow-auto p-[1rem] mt-[1rem] max-h-[28rem]">
                    {JSON.stringify(props.issue.raw, null, 2)}
                </pre>
            </Show>
        </article>
    )
}
