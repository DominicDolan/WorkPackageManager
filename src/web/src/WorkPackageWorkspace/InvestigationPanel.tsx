import { createQuery } from "../hooks/createQuery"
import {
    INVESTIGATION_STATUS_LABELS,
    type Investigation,
    type InvestigationDetail,
    type WorkPackageDetail,
} from "@shared/types"
import { Loading, Show, createEffect, createSignal, refresh } from "solid-js"
import { InvestigationLauncher } from "../InvestigationLauncher/InvestigationLauncher"
import { api } from "../api"
import { PageSkeleton } from "../components/PageSkeleton"
import { RunHistory } from "../components/RunHistory"
import { InvestigationBrief } from "./InvestigationBrief"
import { TabHeading } from "./TabHeading"

export function InvestigationPanel(props: {
    investigation: Investigation
    workPackage: WorkPackageDetail
    changed: () => void
}) {
    const detail = createQuery(async (): Promise<InvestigationDetail> =>
        api.getInvestigation(props.investigation.ref),
    )
    const runs = createQuery(() =>
        api.listAgentRuns({
            kind: "investigation",
            ref: props.investigation.ref,
        }),
    )
    // A run moves the investigation along; its row changing is the cue that the
    // run list, and any conversation id found since, may have too.
    createEffect(
        () => props.investigation.updatedAt,
        () => {
            refresh(detail)
            refresh(runs)
        },
    )
    const [launcherOpen, setLauncherOpen] = createSignal(false)
    return (
        <section class="mx-auto max-w-4xl">
            <TabHeading
                reference={props.investigation.ref}
                title={props.investigation.title}
                description="The brief is the question an agent will research before it creates work."
                rename={(title) =>
                    api.updateInvestigation(props.investigation.ref, { title })
                }
                remove={{
                    label: "Remove",
                    confirm: `Remove ${props.investigation.ref} (${props.investigation.title})? The tasks it filed are kept.`,
                    run: () => api.deleteInvestigation(props.investigation.ref),
                }}
                changed={props.changed}>
                <span class="badge accent p-[0.2rem_0.55rem]">
                    {INVESTIGATION_STATUS_LABELS[props.investigation.status]}
                </span>
            </TabHeading>
            <Loading fallback={<PageSkeleton compact />}>
                <Show when={detail.value} keyed>
                    {(investigation) => (
                        <>
                            <ol class="stepper investigation-flow grid grid-cols-3 mb-4 max-[560px]:grid-cols-[1fr]">
                                <li
                                    aria-current={
                                        investigation.status === "draft"
                                            ? "step"
                                            : undefined
                                    }>
                                    <strong>Brief</strong>
                                    <small>Define the question</small>
                                </li>
                                <li
                                    aria-current={
                                        investigation.status === "investigating"
                                            ? "step"
                                            : undefined
                                    }>
                                    <strong>Investigate</strong>
                                    <small>Agent researches</small>
                                </li>
                                <li
                                    aria-current={
                                        investigation.status === "complete"
                                            ? "step"
                                            : undefined
                                    }>
                                    <strong>Tasks</strong>
                                    <small>Work lands here</small>
                                </li>
                            </ol>
                            <article>
                                <InvestigationBrief
                                    investigation={investigation}
                                    saved={() => {
                                        refresh(detail)
                                        props.changed()
                                    }}
                                />
                                <div class="investigation-actions flex items-center justify-between gap-6 p-[1.2rem_1.5rem] max-[560px]:block">
                                    <div>
                                        <strong>
                                            {investigation.status === "complete"
                                                ? "Investigation complete"
                                                : "Ready to investigate?"}
                                        </strong>
                                        <p class="max-w-[62ch] m-[0.25rem_0_0]">
                                            {investigation.status === "complete"
                                                ? `${investigation.tasks.length} task(s) were created from this investigation.`
                                                : "The agent will only research and plan. Product code is changed later by task agents."}
                                        </p>
                                    </div>
                                    <button
                                        class="primary max-[560px]:mt-4"
                                        aria-busy={
                                            investigation.status ===
                                            "investigating"
                                                ? "true"
                                                : "false"
                                        }
                                        disabled={
                                            !investigation.brief.trim() ||
                                            investigation.status ===
                                                "investigating"
                                        }
                                        onClick={() => setLauncherOpen(true)}>
                                        {investigation.status === "complete"
                                            ? "Run again"
                                            : "Run investigation"}
                                    </button>
                                </div>
                                <Show when={investigation.findings}>
                                    <div class="investigation-findings p-6">
                                        <h4 class="m-0">Findings</h4>
                                        <p class="m-[0.65rem_0_0]">
                                            {investigation.findings}
                                        </p>
                                    </div>
                                </Show>
                            </article>
                            <Loading fallback={null}>
                                <Show when={runs.value.length}>
                                    <section class="mt-6">
                                        <h3 class="m-0 text-sm font-semibold">
                                            Runs
                                        </h3>
                                        <p class="mt-1 mb-3 caption muted">
                                            Reopen an investigation agent's
                                            conversation to pick up where it
                                            left off.
                                        </p>
                                        <RunHistory runs={runs.value} />
                                    </section>
                                </Show>
                            </Loading>
                            <Show when={launcherOpen()}>
                                <InvestigationLauncher
                                    investigation={investigation}
                                    close={() => setLauncherOpen(false)}
                                    started={() => {
                                        refresh(detail)
                                        refresh(runs)
                                        props.changed()
                                    }}
                                />
                            </Show>
                        </>
                    )}
                </Show>
            </Loading>
        </section>
    )
}
