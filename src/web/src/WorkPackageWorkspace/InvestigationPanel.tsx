import {
    INVESTIGATION_STATUS_LABELS,
    type Investigation,
    type InvestigationDetail,
    type WorkPackageDetail,
} from "@shared/types"
import {
    action,
    createOptimistic,
    Loading,
    Show,
    createMemo,
    createSignal,
    refresh,
} from "solid-js"
import { InvestigationLauncher } from "../InvestigationLauncher/InvestigationLauncher"
import { api } from "../api"
import { useError } from "../hooks/useError"
import { PageSkeleton } from "../components/PageSkeleton"
import { InvestigationBrief } from "./InvestigationBrief"

export function InvestigationPanel(props: {
    investigation?: Investigation
    workPackage: WorkPackageDetail
    changed: () => void
}) {
    const detail = createMemo(async (): Promise<InvestigationDetail | null> =>
        props.investigation
            ? api.getInvestigation(props.investigation.ref)
            : null,
    )
    const [busy, setBusy] = createOptimistic(false)
    const { capture, clear, Banner } = useError()
    const [launcherOpen, setLauncherOpen] = createSignal(false)
    const attach = action(function* () {
        if (busy()) return

        setBusy(true)
        clear()
        try {
            yield api.ensureWorkPackageInvestigation(
                props.workPackage.ref,
                props.workPackage.description,
            )

            props.changed()
        } catch (caught) {
            capture(caught)
        }
    })
    return (
        <section class="mx-auto max-w-4xl">
            <header class="section flex items-end justify-between mb-4">
                <div>
                    <h2 class="m-0">Investigation</h2>
                    <p class="m-[0.3rem_0_0]">
                        The brief is the question an agent will research before
                        it creates work.
                    </p>
                </div>
            </header>
            <Show
                when={props.investigation}
                fallback={
                    <article class="highlighted p-[clamp(1.25rem,3vw,2rem)]">
                        <h3 class="m-0">
                            Add an investigation to this work package
                        </h3>
                        <p class="max-w-[65ch] m-[0.55rem_0_1.1rem]">
                            This is an older work package. Its current
                            description can become the investigation brief,
                            without moving or changing any existing tasks.
                        </p>
                        <button
                            aria-busy={busy() ? "true" : "false"}
                            class="primary"
                            disabled={busy()}
                            onClick={attach}>
                            Use description as investigation
                        </button>
                        <Banner />
                    </article>
                }>
                <Loading fallback={<PageSkeleton compact />}>
                    <Show when={detail()} keyed>
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
                                            investigation.status ===
                                            "investigating"
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
                                    <header class="flex items-start justify-between gap-4 p-[1.25rem_1.5rem]">
                                        <div>
                                            <span>{investigation.ref}</span>
                                            <h3 class="m-[0.3rem_0_0]">
                                                {props.workPackage.name}
                                            </h3>
                                        </div>
                                        <span class="badge accent p-[0.2rem_0.55rem]">
                                            {
                                                INVESTIGATION_STATUS_LABELS[
                                                    investigation.status
                                                ]
                                            }
                                        </span>
                                    </header>
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
                                                {investigation.status ===
                                                "complete"
                                                    ? "Investigation complete"
                                                    : "Ready to investigate?"}
                                            </strong>
                                            <p class="max-w-[62ch] m-[0.25rem_0_0]">
                                                {investigation.status ===
                                                "complete"
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
                                            onClick={() =>
                                                setLauncherOpen(true)
                                            }>
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
                                <Show when={launcherOpen()}>
                                    <InvestigationLauncher
                                        investigation={investigation}
                                        close={() => setLauncherOpen(false)}
                                        started={() => {
                                            refresh(detail)
                                            props.changed()
                                        }}
                                    />
                                </Show>
                            </>
                        )}
                    </Show>
                </Loading>
            </Show>
        </section>
    )
}
