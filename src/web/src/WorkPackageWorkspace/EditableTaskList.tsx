import {
    MODEL_TIERS,
    MODEL_TIER_LABELS,
    PRIORITIES,
    type ModelTier,
    type Priority,
    type Task,
    type WorkPackageDetail,
} from "@shared/types"
import {
    action,
    createMemo,
    createOptimistic,
    createSignal,
    For,
    Show,
} from "solid-js"
import { api } from "../api"
import { StatusBadge } from "../components/StatusBadge"
import { useError } from "../hooks/useError"
import { TaskRow } from "./TaskRow"

/** The values a task's row can change. Title is per task, so it never reaches
 *  the bulk form. */
interface Values {
    title: string
    priority: Priority
    recommendedTier: ModelTier | null
    useVisualRegression: boolean
}
type Field = keyof Values
/** Only the fields the user has touched, keyed by task ref. */
type Draft = Partial<Values>

function savedValues(task: Task): Values {
    return {
        title: task.title,
        priority: task.priority,
        recommendedTier: task.recommendedTier,
        useVisualRegression: task.useVisualRegression,
    }
}

/** A task's values as they would be after the pending draft is saved. */
function effective(task: Task, draft: Draft | undefined): Values {
    return { ...savedValues(task), ...draft }
}

/** The draft entries that differ from what the task has saved. */
function changesFor(task: Task, draft: Draft | undefined): Draft {
    const saved = savedValues(task)
    const changes: Record<string, unknown> = {}
    for (const key of Object.keys(saved) as Field[]) {
        const value = draft?.[key]
        if (value !== undefined && value !== saved[key]) changes[key] = value
    }
    return changes as Draft
}

const messageOf = (caught: unknown) =>
    caught instanceof Error ? caught.message : String(caught)

/**
 * The work package's task list, with an edit mode.
 *
 * In edit mode each row becomes inputs, and a checkbox on the left selects it.
 * When two or more rows are selected, a bulk form above the list shows their
 * shared values; changing it changes the same field on every selected row.
 * Nothing is written until Save changes, which sends one update per task that
 * has changes.
 */
export function EditableTaskList(props: {
    workPackage: WorkPackageDetail
    openTask: (ref: string) => void
    /** Refreshes the work package after a save. */
    changed: () => void
}) {
    const [editing, setEditing] = createSignal(false)
    const [selected, setSelected] = createSignal<Set<string>>(new Set())
    const [drafts, setDrafts] = createSignal<Record<string, Draft>>({})
    const [busy, setBusy] = createOptimistic(false)
    const { capture, clear, Banner } = useError()

    const tasks = () => props.workPackage.tasks
    const selectedTasks = createMemo(() =>
        tasks().filter((task) => selected().has(task.ref)),
    )
    const pending = createMemo(() =>
        tasks()
            .map((task) => ({
                task,
                changes: changesFor(task, drafts()[task.ref]),
            }))
            .filter((item) => Object.keys(item.changes).length > 0),
    )
    const titleProblem = () =>
        pending().some(
            ({ changes }) =>
                typeof changes.title === "string" && !changes.title.trim(),
        )

    const setField = <K extends Field>(
        refs: string[],
        key: K,
        value: Values[K],
    ) => {
        const next = { ...drafts() }
        for (const ref of refs)
            next[ref] = { ...next[ref], [key]: value } as Draft
        setDrafts(next)
    }

    /** The shared value of a field across the selection, or Mixed. */
    const shared = <K extends Field>(key: K) => {
        const values = selectedTasks().map(
            (task) => effective(task, drafts()[task.ref])[key],
        )
        return {
            value: values[0],
            mixed: values.some((value) => value !== values[0]),
        }
    }

    const toggleSelected = (ref: string) => {
        const next = new Set(selected())
        if (next.has(ref)) next.delete(ref)
        else next.add(ref)
        setSelected(next)
    }
    const selectedRefs = () => selectedTasks().map((task) => task.ref)

    const toggleEditing = () => {
        if (
            editing() &&
            pending().length &&
            !confirm(
                `Discard ${pending().length} unsaved ${pending().length === 1 ? "change" : "changes"}?`,
            )
        )
            return
        setEditing(!editing())
        setDrafts({})
        setSelected(new Set<string>())
        clear()
    }

    const discard = () => {
        setDrafts({})
        clear()
    }

    const save = action(async function* () {
        if (busy() || !pending().length || titleProblem()) return
        setBusy(true)
        clear()
        const saved: string[] = []
        const failed: string[] = []
        for (const { task, changes } of pending()) {
            try {
                await api.updateTask(task.ref, changes)
                saved.push(task.ref)
            } catch (caught) {
                failed.push(`${task.ref}: ${messageOf(caught)}`)
            }
        }
        yield
        // Only the saved tasks leave the drafts; failures keep their edits.
        const next = { ...drafts() }
        for (const ref of saved) delete next[ref]
        setDrafts(next)
        props.changed()
        if (failed.length)
            capture(
                `Some tasks were not saved. Their changes are still here.\n\n${failed.join("\n")}`,
            )
    })

    const count = () => pending().length

    return (
        <div>
            <div class="mb-3 flex flex-wrap items-center justify-end gap-2">
                <Show when={editing()}>
                    <button
                        class="outlined"
                        disabled={busy() || !tasks().length}
                        onClick={() =>
                            setSelected(
                                new Set(tasks().map((task) => task.ref)),
                            )
                        }>
                        Select all
                    </button>
                    <button
                        class="outlined"
                        disabled={busy() || !selected().size}
                        onClick={() => setSelected(new Set<string>())}>
                        Clear selection
                    </button>
                </Show>
                <button
                    class={editing() ? "primary" : "outlined"}
                    aria-pressed={editing() ? "true" : "false"}
                    disabled={busy()}
                    onClick={toggleEditing}>
                    {editing() ? "Done" : "Edit tasks"}
                </button>
            </div>

            <Banner />

            <Show when={editing() && selectedTasks().length > 1}>
                <article class="elevated mb-4 p-4" data-testid="task-bulk-edit">
                    <header class="mb-3">
                        <h3 class="m-0">
                            Editing {selectedTasks().length} selected tasks
                        </h3>
                        <p class="m-[0.28rem_0_0] caption muted">
                            Changing a field here changes it on every selected
                            task. Nothing is saved until you choose Save
                            changes. Titles are per task, so they are edited on
                            each row.
                        </p>
                    </header>
                    <div class="grid gap-3 sm:grid-cols-3">
                        <label class="field">
                            <span>Priority</span>
                            <select
                                aria-label="Priority for selected tasks"
                                value={
                                    shared("priority").mixed
                                        ? ""
                                        : shared("priority").value
                                }
                                onChange={(event) =>
                                    setField(
                                        selectedRefs(),
                                        "priority",
                                        event.currentTarget.value as Priority,
                                    )
                                }>
                                <Show when={shared("priority").mixed}>
                                    <option value="" disabled>
                                        Mixed
                                    </option>
                                </Show>
                                <For each={PRIORITIES}>
                                    {(priority) => (
                                        <option value={priority}>
                                            {priority}
                                        </option>
                                    )}
                                </For>
                            </select>
                        </label>
                        <label class="field">
                            <span>Recommended model tier</span>
                            <select
                                aria-label="Model tier for selected tasks"
                                value={
                                    shared("recommendedTier").mixed
                                        ? ""
                                        : (shared("recommendedTier").value ??
                                          "")
                                }
                                onChange={(event) =>
                                    setField(
                                        selectedRefs(),
                                        "recommendedTier",
                                        (event.currentTarget.value ||
                                            null) as ModelTier | null,
                                    )
                                }>
                                <Show when={shared("recommendedTier").mixed}>
                                    <option value="" disabled>
                                        Mixed
                                    </option>
                                </Show>
                                <option value="">No preference</option>
                                <For each={MODEL_TIERS}>
                                    {(tier) => (
                                        <option value={tier}>
                                            {MODEL_TIER_LABELS[tier]}
                                        </option>
                                    )}
                                </For>
                            </select>
                        </label>
                        <label class="field">
                            <span>Visual regression</span>
                            <select
                                aria-label="Visual regression for selected tasks"
                                value={
                                    shared("useVisualRegression").mixed
                                        ? ""
                                        : shared("useVisualRegression").value
                                          ? "on"
                                          : "off"
                                }
                                onChange={(event) =>
                                    setField(
                                        selectedRefs(),
                                        "useVisualRegression",
                                        event.currentTarget.value === "on",
                                    )
                                }>
                                <Show
                                    when={shared("useVisualRegression").mixed}>
                                    <option value="" disabled>
                                        Mixed
                                    </option>
                                </Show>
                                <option value="on">On</option>
                                <option value="off">Off</option>
                            </select>
                        </label>
                    </div>
                </article>
            </Show>

            <section class="collection">
                <For
                    each={tasks()}
                    fallback={
                        <p class="p-10 text-center text-sm text-slate-400">
                            This work package has no tasks yet.
                        </p>
                    }>
                    {(task, index) => (
                        <Show
                            when={editing()}
                            fallback={
                                <TaskRow
                                    task={task}
                                    index={index()}
                                    known={tasks()}
                                    onClick={() => props.openTask(task.ref)}
                                />
                            }>
                            <EditRow
                                task={task}
                                values={effective(task, drafts()[task.ref])}
                                selected={selected().has(task.ref)}
                                disabled={busy()}
                                toggleSelected={() => toggleSelected(task.ref)}
                                setField={(key, value) =>
                                    setField([task.ref], key, value)
                                }
                            />
                        </Show>
                    )}
                </For>
            </section>

            <Show when={editing()}>
                <Show when={titleProblem()}>
                    <p class="mt-4 notice warning">
                        A task title cannot be empty.
                    </p>
                </Show>
                <footer class="mt-4 flex flex-wrap items-center justify-between gap-3">
                    <span class="caption muted">
                        {count()
                            ? `${count()} unsaved ${count() === 1 ? "task" : "tasks"}`
                            : "No changes yet"}
                    </span>
                    <div class="flex gap-2">
                        <button
                            class="outlined"
                            disabled={busy() || !count()}
                            onClick={discard}>
                            Discard
                        </button>
                        <button
                            class="primary"
                            disabled={busy() || !count() || titleProblem()}
                            aria-busy={busy() ? "true" : "false"}
                            onClick={save}>
                            Save changes
                        </button>
                    </div>
                </footer>
            </Show>
        </div>
    )
}

/** One task as editable inputs. Its values are the effective ones, so a
 *  bulk change shows up here straight away. */
function EditRow(props: {
    task: Task
    values: Values
    selected: boolean
    disabled: boolean
    toggleSelected: () => void
    setField: <K extends Field>(key: K, value: Values[K]) => void
}) {
    return (
        <div
            class="card-item row flex w-full flex-wrap items-center gap-3 px-4 py-3"
            data-testid="task-edit-row">
            <input
                type="checkbox"
                aria-label={`Select ${props.task.ref}`}
                checked={props.selected}
                disabled={props.disabled}
                onChange={() => props.toggleSelected()}
            />
            <span class="w-16 flex-[0_0_auto] font-mono text-xs text-slate-400">
                {props.task.ref}
            </span>
            <input
                class="min-w-0 flex-1"
                aria-label={`Title of ${props.task.ref}`}
                value={props.values.title}
                disabled={props.disabled}
                onInput={(event) =>
                    props.setField("title", event.currentTarget.value)
                }
            />
            <select
                aria-label={`Priority of ${props.task.ref}`}
                value={props.values.priority}
                disabled={props.disabled}
                onChange={(event) =>
                    props.setField(
                        "priority",
                        event.currentTarget.value as Priority,
                    )
                }>
                <For each={PRIORITIES}>
                    {(priority) => <option value={priority}>{priority}</option>}
                </For>
            </select>
            <select
                aria-label={`Model tier of ${props.task.ref}`}
                value={props.values.recommendedTier ?? ""}
                disabled={props.disabled}
                onChange={(event) =>
                    props.setField(
                        "recommendedTier",
                        (event.currentTarget.value || null) as ModelTier | null,
                    )
                }>
                <option value="">No preference</option>
                <For each={MODEL_TIERS}>
                    {(tier) => (
                        <option value={tier}>{MODEL_TIER_LABELS[tier]}</option>
                    )}
                </For>
            </select>
            <label class="flex items-center gap-1.5 text-xs">
                <input
                    type="checkbox"
                    checked={props.values.useVisualRegression}
                    disabled={props.disabled}
                    onChange={(event) =>
                        props.setField(
                            "useVisualRegression",
                            event.currentTarget.checked,
                        )
                    }
                />
                Visual regression
            </label>
            <StatusBadge status={props.task.status} />
        </div>
    )
}
