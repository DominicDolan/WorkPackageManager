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

/** A note turned into a task or an investigation. The list carries only an
 *  excerpt, so the note is read in full before the form can be filled in. */
export function AddNoteDialog(props: {
    path: string
    kind: WorkItemKind
    close: () => void
    added: (workPackage: { ref: string; name: string }) => void
}) {
    const note = createQuery(() => api.getNote(props.path))
    return (
        <Loading
            fallback={
                <Modal title={WORK_ITEM_TITLES[props.kind]} close={props.close}>
                    <PageSkeleton compact />
                </Modal>
            }>
            <Show when={note.value} keyed>
                {(found) => (
                    <AddToWorkPackage
                        source={{
                            noun: "note",
                            title: found.title,
                            text:
                                `From note \`${found.path}\`` +
                                (found.body.trim()
                                    ? `\n\n${found.body.trim()}`
                                    : ""),
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
