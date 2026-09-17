import { For, Show, createSignal } from "solid-js"
import {
    DEFAULT_ESTIMATE_UNITS,
    MAX_ESTIMATE_UNITS,
    PRIORITIES,
    MODEL_TIERS,
    MODEL_TIER_LABELS,
    type ModelTier,
    type Priority,
} from "@shared/types"
import { api } from "../api"
import { Modal } from "../components/Modal"

export function CreateTask(props: {
    workPackage: { ref: string; name: string }
    close: () => void
    created: (ref: string) => void
}) {
    const [title, setTitle] = createSignal("")
    const [description, setDescription] = createSignal("")
    const [priority, setPriority] = createSignal<Priority>("medium")
    const [recommendedTier, setRecommendedTier] = createSignal<ModelTier | "">(
        "",
    )
    const [estimateUnits, setEstimateUnits] = createSignal(
        DEFAULT_ESTIMATE_UNITS,
    )
    const [tags, setTags] = createSignal("")
    const [useGitWorkflow, setUseGitWorkflow] = createSignal(true)
    const [branchName, setBranchName] = createSignal("")
    const [busy, setBusy] = createSignal(false)
    const [error, setError] = createSignal("")
    const estimateValid = () =>
        Number.isInteger(estimateUnits()) &&
        estimateUnits() >= 1 &&
        estimateUnits() <= MAX_ESTIMATE_UNITS

    const submit = async () => {
        if (!title().trim() || !estimateValid() || busy()) return
        setBusy(true)
        setError("")
        try {
            const task = await api.createTask({
                title: title(),
                description: description(),
                priority: priority(),
                recommendedTier: recommendedTier() || null,
                estimateUnits: estimateUnits(),
                tags: [
                    ...new Set(
                        tags()
                            .split(",")
                            .map((tag) => tag.trim())
                            .filter(Boolean),
                    ),
                ],
                useGitWorkflow: useGitWorkflow(),
                branchName: useGitWorkflow()
                    ? branchName().trim() || undefined
                    : undefined,
                workPackageRef: props.workPackage.ref,
            })
            props.created(task.ref)
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught))
        } finally {
            setBusy(false)
        }
    }

    return (
        <Modal title="Add task" close={props.close}>
            <p class="description m-0">
                Add work directly to <strong>{props.workPackage.name}</strong>.
                You can keep the normal branch workflow or turn it off for
                ignored, local-only files.
            </p>
            <label class="field mt-4">
                <span>
                    Recommended model{" "}
                    <small class={"optional"}>(optional)</small>
                </span>
                <select
                    value={recommendedTier()}
                    onChange={(event) =>
                        setRecommendedTier(
                            event.currentTarget.value as ModelTier | "",
                        )
                    }
                >
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
            <label class="field mt-4">
                <span>Title</span>
                <input
                    autofocus
                    value={title()}
                    onInput={(event) => setTitle(event.currentTarget.value)}
                    onKeyDown={(event) => event.key === "Enter" && submit()}
                    placeholder="e.g. Add retry handling to the release step"
                />
            </label>
            <label class="field mt-4">
                <span>Description</span>
                <textarea
                    value={description()}
                    onInput={(event) =>
                        setDescription(event.currentTarget.value)
                    }
                    placeholder="Describe the desired outcome, context, and acceptance criteria."
                />
            </label>
            <div class="mt-4 grid grid-cols-[1fr_1fr] gap-[1rem] max-[520px]:grid-cols-[1fr]">
                <label class="field">
                    <span>Priority</span>
                    <select
                        value={priority()}
                        onChange={(event) =>
                            setPriority(event.currentTarget.value as Priority)
                        }
                    >
                        <For each={PRIORITIES}>
                            {(value) => <option value={value}>{value}</option>}
                        </For>
                    </select>
                </label>
                <label class="field">
                    <span>Estimate units</span>
                    <input
                        type="number"
                        min="1"
                        max={MAX_ESTIMATE_UNITS}
                        value={estimateUnits()}
                        onInput={(event) =>
                            setEstimateUnits(event.currentTarget.valueAsNumber)
                        }
                    />
                </label>
            </div>
            <label class="field mt-4">
                <span>
                    Tags{" "}
                    <small class={"optional"}>
                        (optional, comma separated)
                    </small>
                </span>
                <input
                    value={tags()}
                    onInput={(event) => setTags(event.currentTarget.value)}
                    placeholder="frontend, reliability"
                />
            </label>
            <label class="choice mt-4 flex items-start gap-[0.75rem] p-[0.85rem] [&_input]:w-[1rem] [&_input]:h-[1rem] [&_input]:mt-[0.12rem] [&_span]:grid [&_span]:gap-[0.22rem]">
                <input
                    type="checkbox"
                    checked={useGitWorkflow()}
                    onChange={(event) =>
                        setUseGitWorkflow(event.currentTarget.checked)
                    }
                />
                <span>
                    <strong>Use Git workflow</strong>
                    <small>
                        Create a task branch and merge completed work into the
                        work package branch.
                    </small>
                </span>
            </label>
            <Show when={useGitWorkflow()}>
                <label class="field mt-4">
                    <span>
                        Task branch <small class={"optional"}>(optional)</small>
                    </span>
                    <input
                        class={"code"}
                        value={branchName()}
                        onInput={(event) =>
                            setBranchName(event.currentTarget.value)
                        }
                        placeholder="Generated from the task title"
                    />
                </label>
            </Show>
            <Show when={error()}>
                <p class="notice error mt-4">{error()}</p>
            </Show>
            <div class="mt-5 flex justify-end gap-2">
                <button
                    class="outlined"
                    disabled={busy()}
                    onClick={props.close}
                >
                    Cancel
                </button>
                <button
                    aria-busy={busy() ? "true" : "false"}
                    class="primary"
                    disabled={!title().trim() || !estimateValid() || busy()}
                    onClick={submit}
                >
                    Add task
                </button>
            </div>
        </Modal>
    )
}
