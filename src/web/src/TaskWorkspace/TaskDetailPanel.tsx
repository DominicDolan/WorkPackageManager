import {
    STATUSES,
    STATUS_LABELS,
    MODEL_TIER_LABELS,
    type Priority,
    type TaskDetail,
    type TaskVisualSync,
    type WorkPackageDetail,
    type WorkPackageSummary,
} from "@shared/types"
import { For, Show } from "solid-js"
import { api, taskAssetUrl } from "../api"
import { InfoCard } from "../components/InfoCard"
import { TranscriptAttachments } from "../components/TranscriptAttachments"
import { StatusBadge } from "../components/StatusBadge"
import { ComparisonViewer } from "./ComparisonViewer"

export function TaskDetailPanel(props: {
    task: TaskDetail
    workPackage: WorkPackageDetail | null
    workPackages: WorkPackageSummary[]
    busy: string
    error: string
    editing: boolean
    setEditing: (value: boolean) => void
    note: string
    setNote: (value: string) => void
    mutate: (
        label: string,
        request: () => Promise<unknown>,
        onSuccess?: () => void,
    ) => Promise<void>
    openAgent: () => void
    revision: number
    visualSync: TaskVisualSync | null
    syncVisuals: () => void
}) {
    let title!: HTMLInputElement
    let description!: HTMLTextAreaElement
    let priority!: HTMLSelectElement
    let recommendedTier!: HTMLSelectElement
    let visualRegression!: HTMLInputElement
    return (
        <article class="document p-5 sm:p-8 lg:p-10 min-w-0 max-w-[1320px]">
            <Show when={props.error}>
                <p class="notice error mb-5">{props.error}</p>
            </Show>
            <header class="detail flex flex-wrap items-start justify-between gap-4 pb-[1.65rem]">
                <div>
                    <div class="flex items-center gap-2">
                        <span class="reference">{props.task.ref}</span>
                        <StatusBadge status={props.task.status} />
                        <span
                            class={`badge inline-flex items-center p-[0.16rem_0.48rem] ${props.task.recommendedTier === "frontier" ? "accent" : ""}`}
                            title="Recommended model tier">
                            {props.task.recommendedTier
                                ? MODEL_TIER_LABELS[props.task.recommendedTier]
                                : "No model tier"}
                        </span>
                    </div>
                    <h1 class="max-w-[25ch] m-[0.65rem_0_0]">
                        {props.task.title}
                    </h1>
                </div>
                <div class="flex gap-2">
                    <Show when={props.workPackage}>
                        <button class="primary" onClick={props.openAgent}>
                            Work with agent
                        </button>
                    </Show>
                    <button
                        class="outlined"
                        onClick={() => props.setEditing(!props.editing)}>
                        {props.editing ? "Cancel" : "Edit"}
                    </button>
                </div>
            </header>
            <Show when={props.task.gitError}>
                {(failure) => (
                    <aside
                        class="notice error mt-4"
                        role="alert"
                        data-testid="task-git-error">
                        <div class="flex flex-wrap items-start justify-between gap-3">
                            <strong>
                                A Git operation for this task failed —{" "}
                                {new Date(failure().at).toLocaleString()}
                            </strong>
                            <button
                                class="outlined"
                                disabled={!!props.busy}
                                aria-busy={
                                    props.busy === "merge" ? "true" : "false"
                                }
                                onClick={() =>
                                    props.mutate("merge", () =>
                                        api.mergeIntoWorkPackageBranch(
                                            props.task.ref,
                                        ),
                                    )
                                }>
                                Retry merge
                            </button>
                        </div>
                        <p class="mt-2 mb-0">
                            Nothing was changed on the branch it failed on.
                            Resolve it by hand (or ask an agent), then retry.
                        </p>
                        <pre class="mt-2 max-h-60 overflow-auto p-3">
                            {failure().message}
                        </pre>
                    </aside>
                )}
            </Show>
            <Show
                when={props.editing}
                fallback={
                    <p class="description whitespace-pre-wrap max-w-[76ch] m-[1.5rem_0_0]">
                        {props.task.description ||
                            "Add a description so the expected change is unambiguous."}
                    </p>
                }>
                <article class="mt-6 p-5">
                    <label class="field">
                        <span>Title</span>
                        <input ref={title} value={props.task.title} />
                    </label>
                    <label class="field mt-4">
                        <span>Description</span>
                        <textarea
                            ref={description}
                            value={props.task.description}
                        />
                    </label>
                    <div class="mt-4 grid gap-4 sm:grid-cols-2">
                        <label class="field">
                            <span>Priority</span>
                            <select ref={priority} value={props.task.priority}>
                                <option>low</option>
                                <option>medium</option>
                                <option>high</option>
                            </select>
                        </label>
                        <label class="field">
                            <span>Recommended model tier</span>
                            <select
                                ref={recommendedTier}
                                value={props.task.recommendedTier ?? ""}>
                                <option value="">No preference</option>
                                <option value="fast">Fast</option>
                                <option value="standard">Standard</option>
                                <option value="frontier">Frontier</option>
                            </select>
                        </label>
                        <label class="field">
                            <span>Work package</span>
                            <select
                                value={props.task.workPackageRef ?? ""}
                                onChange={(event) =>
                                    props.mutate("work-package", () =>
                                        api.setWorkPackage(
                                            props.task.ref,
                                            event.currentTarget.value,
                                        ),
                                    )
                                }
                                disabled={!props.task.workPackageRef}>
                                <For each={props.workPackages}>
                                    {(workPackage) => (
                                        <option value={workPackage.ref}>
                                            {workPackage.name}
                                        </option>
                                    )}
                                </For>
                            </select>
                        </label>
                    </div>
                    <label class="choice mt-4 flex items-start gap-[0.75rem] p-[0.85rem]">
                        <input
                            ref={visualRegression}
                            type="checkbox"
                            class="w-[1rem] h-[1rem] mt-[0.12rem]"
                            checked={props.task.useVisualRegression}
                        />
                        <span class="grid gap-[0.22rem]">
                            <strong>Visual regression</strong>
                            <small>
                                Drive this task through before/after
                                checkpoints. Off leaves them out of the agent's
                                instructions.
                            </small>
                        </span>
                    </label>
                    <button
                        class="primary mt-4"
                        disabled={!!props.busy}
                        aria-busy={props.busy === "save" ? "true" : "false"}
                        onClick={() =>
                            props.mutate(
                                "save",
                                () =>
                                    api.updateTask(props.task.ref, {
                                        title: title.value,
                                        description: description.value,
                                        priority: priority.value as Priority,
                                        recommendedTier:
                                            (recommendedTier.value ||
                                                null) as TaskDetail["recommendedTier"],
                                        useVisualRegression:
                                            visualRegression.checked,
                                    }),
                                () => props.setEditing(false),
                            )
                        }>
                        Save changes
                    </button>
                </article>
            </Show>

            <TranscriptAttachments
                kind="task"
                ref={props.task.ref}
                revision={props.revision}
            />

            <section class="mt-8">
                <h2 class="title mb-4">Workflow</h2>
                <div class="flex flex-wrap gap-2">
                    <For each={STATUSES}>
                        {(status) => (
                            <button
                                class={
                                    status === props.task.status
                                        ? "primary "
                                        : "outlined "
                                }
                                disabled={
                                    !!props.busy ||
                                    status === props.task.status ||
                                    status === "closed"
                                }
                                onClick={() =>
                                    props.mutate(status, () =>
                                        api.setStatus(props.task.ref, status),
                                    )
                                }>
                                {STATUS_LABELS[status]}
                            </button>
                        )}
                    </For>
                    <Show when={props.task.status === "verified"}>
                        <button
                            class="primary"
                            onClick={() =>
                                props.mutate("close", () =>
                                    api.closeTask(props.task.ref),
                                )
                            }>
                            Close task
                        </button>
                    </Show>
                </div>
            </section>

            <div class="mt-8 grid gap-6 xl:grid-cols-2">
                <InfoCard title="Details">
                    <dl class="space-y-3 text-sm">
                        <Detail label="Priority" value={props.task.priority} />
                        <Detail
                            label="Recommended model tier"
                            value={
                                props.task.recommendedTier
                                    ? MODEL_TIER_LABELS[
                                          props.task.recommendedTier
                                      ]
                                    : "No preference"
                            }
                        />
                        <Detail
                            label="Git workflow"
                            value={
                                props.task.useGitWorkflow
                                    ? "Enabled"
                                    : "Disabled"
                            }
                        />
                        <Detail
                            label="Visual regression"
                            value={
                                props.task.useVisualRegression
                                    ? "Enabled"
                                    : "Disabled"
                            }
                        />
                        <Detail
                            label="Branch"
                            value={
                                props.task.branchName ??
                                (props.task.useGitWorkflow ? "—" : "Not used")
                            }
                        />
                        <Detail
                            label="Estimate"
                            value={`${props.task.estimateUnits} unit(s)`}
                        />
                        <Detail
                            label="Investigation"
                            value={props.task.investigationRef ?? "—"}
                        />
                        <Detail
                            label="Tags"
                            value={props.task.tags.join(", ") || "—"}
                        />
                    </dl>
                </InfoCard>
                <InfoCard title="Dependencies">
                    <Show
                        when={props.task.dependsOn.length}
                        fallback={<p class="description">No blockers.</p>}>
                        <div class="flex flex-wrap gap-2">
                            <For each={props.task.dependsOn}>
                                {(ref) => (
                                    <span class="rounded-lg bg-slate-100 px-2 py-1 font-mono text-xs">
                                        {ref}
                                    </span>
                                )}
                            </For>
                        </div>
                    </Show>
                    <Show when={props.task.blocks.length}>
                        <p class="mt-4 caption muted">
                            Blocks {props.task.blocks.join(", ")}
                        </p>
                    </Show>
                </InfoCard>
            </div>

            <section class="mt-8">
                <div class="mb-4 flex flex-wrap items-center justify-between gap-3">
                    <div>
                        <h2 class="title">Visual checkpoints</h2>
                        <p class="mt-1 caption muted">
                            The latest capture is shown at the full
                            detail-column width.
                        </p>
                    </div>
                    <div class="flex flex-wrap gap-2">
                        <button
                            aria-busy={
                                props.busy === "before" ? "true" : "false"
                            }
                            class="outlined"
                            disabled={!!props.busy}
                            onClick={() =>
                                props.mutate("before", () =>
                                    api.capture(props.task.ref, "before"),
                                )
                            }>
                            Capture before
                        </button>
                        <button
                            aria-busy={
                                props.busy === "after" ? "true" : "false"
                            }
                            class="outlined"
                            disabled={!!props.busy}
                            onClick={() =>
                                props.mutate("after", () =>
                                    api.capture(props.task.ref, "after"),
                                )
                            }>
                            Capture after
                        </button>
                        <button
                            class="outlined"
                            disabled={!!props.busy || !props.task.runs.length}
                            aria-busy={
                                props.busy === "sync-visuals" ? "true" : "false"
                            }
                            title="Copy this task's VR screenshots and metadata to the notes repository and commit them locally"
                            onClick={props.syncVisuals}>
                            {props.busy === "sync-visuals"
                                ? "Syncing…"
                                : "Sync VR to notes"}
                        </button>
                    </div>
                </div>
                <Show when={props.visualSync}>
                    {(sync) => (
                        <p class="notice mb-4" role="status">
                            {sync().fileCount} VR files synced to notes at{" "}
                            {sync().path}.{" "}
                            {sync().committed
                                ? `Committed ${sync().committed}.`
                                : "Already up to date."}{" "}
                            <a
                                href={`/notes?note=${encodeURIComponent(sync().reportPath)}`}>
                                Open report
                            </a>
                            <Show when={sync().missingArtifacts.length}>
                                {" "}
                                {sync().missingArtifacts.length} source files
                                are missing; see README.md in the export.
                            </Show>
                        </p>
                    )}
                </Show>
                <Show
                    when={props.task.runs.at(-1)}
                    fallback={
                        <div class="empty outlined p-[2.5rem]">
                            No visual runs yet.
                        </div>
                    }>
                    {(run) => (
                        <div class="space-y-5">
                            <div class="flex justify-between caption muted">
                                <span class="capitalize">
                                    Latest {run().phase} capture
                                </span>
                                <time>
                                    {run()
                                        .createdAt.slice(0, 16)
                                        .replace("T", " ")}
                                </time>
                            </div>
                            <For each={run().comparisons}>
                                {(comparison) => (
                                    <ComparisonViewer comparison={comparison} />
                                )}
                            </For>
                        </div>
                    )}
                </Show>
            </section>

            <section class="mt-8">
                <h2 class="title mb-4">Attachments</h2>
                <div class="flex flex-wrap gap-2">
                    <For
                        each={props.task.attachments}
                        fallback={
                            <span class="description">No attachments.</span>
                        }>
                        {(attachment) => (
                            <a
                                class="outlined"
                                href={taskAssetUrl(
                                    props.task.ref,
                                    attachment.name,
                                )}
                                target="_blank">
                                {attachment.name}
                            </a>
                        )}
                    </For>
                </div>
            </section>

            <section class="mt-8">
                <h2 class="title mb-4">Notes and history</h2>
                <article class="p-5">
                    <div class="flex gap-2">
                        <input
                            class="flex-1 w-full p-[0.68rem_0.75rem]"
                            value={props.note}
                            onInput={(event) =>
                                props.setNote(event.currentTarget.value)
                            }
                            placeholder="Add a note…"
                        />
                        <button
                            class="primary"
                            disabled={!props.note.trim() || !!props.busy}
                            aria-busy={props.busy === "note" ? "true" : "false"}
                            onClick={() =>
                                props.mutate(
                                    "note",
                                    () =>
                                        api.addNote(props.task.ref, props.note),
                                    () => props.setNote(""),
                                )
                            }>
                            Add note
                        </button>
                    </div>
                    <ol class="ruled mt-5 space-y-4">
                        <For each={[...props.task.events].reverse()}>
                            {(event) => (
                                <li>
                                    <div class="flex gap-2 caption muted">
                                        <span class="capitalize">
                                            {event.type.replaceAll("_", " ")}
                                        </span>
                                        <time>
                                            {event.createdAt
                                                .slice(0, 16)
                                                .replace("T", " ")}
                                        </time>
                                    </div>
                                    <Show when={event.note}>
                                        <p class="mt-1 text-sm text-slate-600">
                                            {event.note}
                                        </p>
                                    </Show>
                                </li>
                            )}
                        </For>
                    </ol>
                </article>
            </section>
        </article>
    )
}

function Detail(props: { label: string; value: string }) {
    return (
        <div class="flex justify-between gap-4">
            <dt class="text-slate-400">{props.label}</dt>
            <dd class="break-all text-right font-medium capitalize">
                {props.value}
            </dd>
        </div>
    )
}
