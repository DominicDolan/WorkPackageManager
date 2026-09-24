import { Loading, Show } from "solid-js"
import { api } from "../api"
import {
    AddToWorkPackage,
    WORK_ITEM_TITLES,
    type WorkItemKind,
} from "../components/AddToWorkPackage"
import { Modal } from "../components/Modal"
import { PageSkeleton } from "../components/PageSkeleton"
import { createQuery } from "../hooks/createQuery"
import { issueAsMarkdown } from "./issueBody"

/** An issue turned into a task or an investigation. The body is only on the
 *  detail, so the issue is read in full before the form can be filled in. */
export function AddIssueDialog(props: {
    issueId: string
    kind: WorkItemKind
    close: () => void
    added: (workPackage: { ref: string; name: string }) => void
}) {
    const issue = createQuery(() => api.getIssue(props.issueId))
    return (
        <Loading
            fallback={
                <Modal title={WORK_ITEM_TITLES[props.kind]} close={props.close}>
                    <PageSkeleton compact />
                </Modal>
            }>
            <Show when={issue.value} keyed>
                {(found) => (
                    <AddToWorkPackage
                        source={{
                            noun: "issue",
                            title: `${found.key} ${found.title}`.trim(),
                            text: issueAsMarkdown(found),
                        }}
                        kind={props.kind}
                        close={props.close}
                        added={props.added}
                    />
                )}
            </Show>
        </Loading>
    )
}
