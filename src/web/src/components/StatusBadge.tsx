import { STATUS_LABELS, type Status } from "@shared/types"
import { statusClass } from "../utils/statusClass"
import styles from "./StatusBadge.module.css"

export function StatusBadge(props: { status: Status }) {
    return (
        <span
            class={`${styles.scope} status-badge ${statusClass(props.status)} inline-flex items-center p-[0.16rem_0.48rem]`}
        >
            {STATUS_LABELS[props.status]}
        </span>
    )
}
