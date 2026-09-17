import { ISSUE_SOURCE_LABELS, type IssueDetail } from "@shared/types"
import { Show, createSignal } from "solid-js"
import { BackIcon } from "../components/icons"

export function IssueDetailPane(props: {
    issue: IssueDetail
    back: () => void
}) {
    const [raw, setRaw] = createSignal(false)
    return (
        <article class="document max-[560px]:[&_header]:block max-[560px]:[&_header_.primary]:mt-[1rem] max-w-[980px] p-[clamp(1.25rem,_3vw,_3rem)] [&_header]:flex [&_header]:items-start [&_header]:justify-between [&_header]:gap-[1rem] [&_header]:pb-[1.25rem] [&_h2]:max-w-[25ch] [&_h2]:m-[0.4rem_0_0] max-w-[1100px] [&>.back]:mb-[1.4rem]">
            <button
                class="back inline-flex items-center gap-[0.35rem]"
                onClick={props.back}>
                <BackIcon />
                All issues
            </button>
            <header>
                <div>
                    <span class="badge info inline-flex mr-[0.45rem] p-[0.15rem_0.42rem]">
                        {ISSUE_SOURCE_LABELS[props.issue.source] ??
                            props.issue.source}
                    </span>
                    <span class="reference">{props.issue.key}</span>
                    <h2>{props.issue.title}</h2>
                </div>
                <Show when={props.issue.url}>
                    {(url) => (
                        <a
                            class="primary"
                            href={url()}
                            target="_blank"
                            rel="noreferrer">
                            Open source
                        </a>
                    )}
                </Show>
            </header>
            <dl class="properties grid grid-cols-[repeat(2,_minmax(0,_1fr))] gap-[1px] m-[1.5rem_0] [&>div]:p-[0.8rem] [&_dd]:m-[0.25rem_0_0] max-[560px]:grid-cols-[1fr]">
                <div>
                    <dt>State</dt>
                    <dd>{props.issue.stateLabel}</dd>
                </div>
                <div>
                    <dt>Assigned</dt>
                    <dd>
                        {props.issue.assignees
                            .map((person) => person.name)
                            .join(", ") || "Unassigned"}
                    </dd>
                </div>
                <div>
                    <dt>Updated</dt>
                    <dd>
                        {props.issue.updatedAt
                            ? new Date(
                                  props.issue.updatedAt,
                              ).toLocaleDateString()
                            : "—"}
                    </dd>
                </div>
                <div>
                    <dt>Comments</dt>
                    <dd>{props.issue.commentCount ?? "—"}</dd>
                </div>
            </dl>
            <section class="content m-[1.5rem_0] [&_pre]:overflow-auto [&_pre]:p-[1rem]">
                <h3>Description</h3>
                <pre>{props.issue.body || "No description."}</pre>
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
