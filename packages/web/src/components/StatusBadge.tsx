import { STATUS_LABELS, type Status } from "@work-task-manager/shared"

export function StatusBadge(props: { status: Status }) {
    return (
        <span
            class="badge inline-flex items-center p-[0.16rem_0.48rem]"
            data-status={props.status}>
            {STATUS_LABELS[props.status]}
        </span>
    )
}
