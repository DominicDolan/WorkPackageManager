import {
    action,
    createOptimistic,
    createSignal,
    For,
    Loading,
    Show,
} from "solid-js"
import type { WorkPackageSummary } from "@shared/types"
import { api } from "../api"
import { Modal } from "./Modal"
import { PageSkeleton } from "./PageSkeleton"
import { createQuery } from "../hooks/createQuery"
import { useError } from "../hooks/useError"

/** What a piece of imported context can be turned into. */
export type WorkItemKind = "task" | "investigation"

/** The record being turned into work, and the text it starts the form with. */
export interface WorkSource {
    /** What it is, for the dialog's own wording — "issue" or "note". */
    noun: string
    title: string
    text: string
}

export const WORK_ITEM_TITLES: Record<WorkItemKind, string> = {
    task: "Add as task",
    investigation: "Add as investigation",
}

/**
 * Turn an issue or a note into a task or an investigation in a work package,
 * either one that exists or one made here. The text is copied, not linked: the
 * task or investigation stands on its own once it is made.
 */
export function AddToWorkPackage(props: {
    source: WorkSource
    kind: WorkItemKind
    close: () => void
    added: (workPackage: { ref: string; name: string }) => void
}) {
    const workPackages = createQuery(() => api.listWorkPackages())
    return (
        <Modal title={WORK_ITEM_TITLES[props.kind]} close={props.close}>
            <Loading fallback={<PageSkeleton compact />}>
                <Show when={workPackages.value}>
                    <AddForm
                        source={props.source}
                        workPackages={workPackages.value}
                        kind={props.kind}
                        close={props.close}
                        added={props.added}
                    />
                </Show>
            </Loading>
        </Modal>
    )
}

function AddForm(props: {
    source: WorkSource
    workPackages: WorkPackageSummary[]
    kind: WorkItemKind
    close: () => void
    added: (workPackage: { ref: string; name: string }) => void
}) {
    const [mode, setMode] = createSignal<"existing" | "new">(
        props.workPackages.length ? "existing" : "new",
    )
    const [workPackageRef, setWorkPackageRef] = createSignal(
        props.workPackages[0]?.ref ?? "",
    )
    const [workPackageName, setWorkPackageName] = createSignal(
        props.source.title,
    )
    const [title, setTitle] = createSignal(props.source.title)
    const [text, setText] = createSignal(props.source.text)
    // A work package made by an attempt that then failed, so a retry adds to it
    // rather than making another.
    let made: { ref: string; name: string } | null = null
    const [busy, setBusy] = createOptimistic(false)
    const { capture, clear, Banner } = useError()

    const ready = () =>
        !!title().trim() &&
        (mode() === "new" ? !!workPackageName().trim() : !!workPackageRef())

    const submit = action(async function* () {
        if (busy() || !ready()) return

        setBusy(true)
        clear()
        try {
            let target: { ref: string; name: string } = props.workPackages.find(
                (item) => item.ref === workPackageRef(),
            )!
            if (mode() === "new") {
                made ??= (
                    await api.createWorkPackage({ name: workPackageName() })
                ).workPackage
                target = made
            }
            if (props.kind === "task")
                await api.createTask({
                    title: title(),
                    description: text(),
                    workPackageRef: target.ref,
                })
            else
                await api.addWorkPackageInvestigation(target.ref, {
                    title: title(),
                    brief: text(),
                })
            yield
            props.added({ ref: target.ref, name: target.name })
        } catch (caught) {
            yield
            capture(caught)
        }
    })

    return (
        <>
            <p class="description m-0">
                {props.kind === "task"
                    ? `Create a task from this ${props.source.noun}`
                    : `Write this ${props.source.noun} down as an investigation`}{" "}
                in a work package.
            </p>
            <fieldset class="mt-4 grid min-w-0 gap-2">
                <legend class="label">Work package</legend>
                <div class="flex flex-wrap gap-2">
                    <label class="choice compact">
                        <input
                            type="radio"
                            name="add-to-work-package"
                            value="existing"
                            checked={mode() === "existing"}
                            disabled={!props.workPackages.length}
                            onChange={() => setMode("existing")}
                        />
                        <span>Existing work package</span>
                    </label>
                    <label class="choice compact">
                        <input
                            type="radio"
                            name="add-to-work-package"
                            value="new"
                            checked={mode() === "new"}
                            onChange={() => setMode("new")}
                        />
                        <span>New work package</span>
                    </label>
                </div>
            </fieldset>
            <Show
                when={mode() === "existing"}
                fallback={
                    <label class="field mt-4">
                        <span>Work package name</span>
                        <input
                            value={workPackageName()}
                            onInput={(event) =>
                                setWorkPackageName(event.currentTarget.value)
                            }
                            placeholder="e.g. Improve release confidence"
                        />
                    </label>
                }>
                <label class="field mt-4">
                    <span>Work package</span>
                    <select
                        value={workPackageRef()}
                        onChange={(event) =>
                            setWorkPackageRef(event.currentTarget.value)
                        }>
                        <For each={props.workPackages}>
                            {(item) => (
                                <option value={item.ref}>
                                    {item.ref} · {item.name}
                                </option>
                            )}
                        </For>
                    </select>
                </label>
            </Show>
            <label class="field mt-4">
                <span>Title</span>
                <input
                    autofocus
                    value={title()}
                    onInput={(event) => setTitle(event.currentTarget.value)}
                />
            </label>
            <label class="field mt-4">
                <span>{props.kind === "task" ? "Description" : "Brief"}</span>
                <textarea
                    rows={10}
                    value={text()}
                    onInput={(event) => setText(event.currentTarget.value)}
                />
            </label>
            <Banner />
            <div class="mt-5 flex justify-end gap-2">
                <button
                    class="outlined"
                    disabled={busy()}
                    onClick={props.close}>
                    Cancel
                </button>
                <button
                    class="primary"
                    aria-busy={busy() ? "true" : "false"}
                    disabled={busy() || !ready()}
                    onClick={submit}>
                    {props.kind === "task" ? "Add task" : "Add investigation"}
                </button>
            </div>
        </>
    )
}

/** The buttons that turn a record into work, on its card and its detail pane. */
export function AddToWorkPackageButtons(props: {
    add: (kind: WorkItemKind) => void
}) {
    return (
        <div class="flex flex-wrap gap-[0.5rem]">
            <button class="outlined" onClick={() => props.add("task")}>
                Add as task
            </button>
            <button class="outlined" onClick={() => props.add("investigation")}>
                Add as investigation
            </button>
        </div>
    )
}
