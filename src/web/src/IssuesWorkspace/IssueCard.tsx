import { ISSUE_SOURCE_LABELS, type IssueSummary } from "@shared/types"

export function IssueCard(props: {
    issue: IssueSummary
    open: () => void
    busy?: boolean
}) {
    return (
        <button
            class="card-item block w-full mb-[0.8rem] p-[1rem]"
            onClick={props.open}
            aria-busy={props.busy ? "true" : "false"}>
            <div>
                <span class="badge info inline-flex mr-[0.45rem] p-[0.15rem_0.42rem]">
                    {ISSUE_SOURCE_LABELS[props.issue.source] ??
                        props.issue.source}
                </span>
                <span class="reference">{props.issue.key}</span>
                <span
                    class="badge success inline-flex mr-[0.45rem] p-[0.15rem_0.42rem]"
                    data-status={props.issue.state}>
                    {props.issue.stateLabel}
                </span>
            </div>
            <h2 class="m-[0.7rem_0_0]">{props.issue.title}</h2>
            <p class="m-[0.5rem_0]">
                {props.issue.excerpt ||
                    props.issue.container ||
                    "No summary provided."}
            </p>
            <footer class="flex flex-wrap gap-[0.35rem]">
                {props.issue.labels.slice(0, 3).map((label) => (
                    <span class="p-[0.1rem_0.35rem]">{label.name}</span>
                ))}
            </footer>
        </button>
    )
}
