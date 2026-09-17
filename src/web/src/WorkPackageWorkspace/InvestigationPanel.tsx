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
    const [error, setError] = createSignal("")
    const [launcherOpen, setLauncherOpen] = createSignal(false)
    const attach = action(function* () {
        if (busy()) return

        setBusy(true)
        setError("")
        try {
            yield api.ensureWorkPackageInvestigation(
                props.workPackage.ref,
                props.workPackage.description,
            )

            props.changed()
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught))
        }
    })
    return (
        <section class="mx-auto max-w-4xl">
            <header class="section flex items-end justify-between mb-4 [&_h2]:m-0 [&_p]:m-[0.3rem_0_0]">
                <div>
                    <h2>Investigation</h2>
                    <p>
                        The brief is the question an agent will research before
                        it creates work.
                    </p>
                </div>
            </header>
            <Show
                when={props.investigation}
                fallback={
                    <article class="highlighted p-[clamp(1.25rem,_3vw,_2rem)] [&_h3]:m-0 [&>p]:max-w-[65ch] [&>p]:m-[0.55rem_0_1.1rem]">
                        <h3>Add an investigation to this work package</h3>
                        <p>
                            This is an older work package. Its current
                            description can become the investigation brief,
                            without moving or changing any existing tasks.
                        </p>
                        <button
                            aria-busy={busy() ? "true" : "false"}
                            class="primary"
                            disabled={busy()}
                            onClick={attach}
                        >
                            Use description as investigation
                        </button>
                        <Show when={error()}>
                            <p class="notice error mt-4">{error()}</p>
                        </Show>
                    </article>
                }
            >
                <Loading fallback={<PageSkeleton compact />}>
                    <Show when={detail()} keyed>
                        {(investigation) => (
                            <>
                                <ol class="stepper investigation-flow grid grid-cols-[repeat(3,_minmax(0,_1fr))] mb-[1rem] max-[560px]:grid-cols-[1fr]">
                                    <li
                                        aria-current={
                                            investigation.status === "draft"
                                                ? "step"
                                                : undefined
                                        }
                                    >
                                        <strong>Brief</strong>
                                        <small>Define the question</small>
                                    </li>
                                    <li
                                        aria-current={
                                            investigation.status ===
                                            "investigating"
                                                ? "step"
                                                : undefined
                                        }
                                    >
                                        <strong>Investigate</strong>
                                        <small>Agent researches</small>
                                    </li>
                                    <li
                                        aria-current={
                                            investigation.status === "complete"
                                                ? "step"
                                                : undefined
                                        }
                                    >
                                        <strong>Tasks</strong>
                                        <small>Work lands here</small>
                                    </li>
                                </ol>
                                <article class="[&>header]:flex [&>header]:items-start [&>header]:justify-between [&>header]:gap-[1rem] [&>header]:p-[1.25rem_1.5rem] [&>header_h3]:m-[0.3rem_0_0]">
                                    <header>
                                        <div>
                                            <span>{investigation.ref}</span>
                                            <h3>{props.workPackage.name}</h3>
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
                                    <div class="investigation-actions flex items-center justify-between gap-[1.5rem] p-[1.2rem_1.5rem] [&_p]:max-w-[62ch] [&_p]:m-[0.25rem_0_0] max-[560px]:block max-[560px]:[&_.primary]:mt-[1rem]">
                                        <div>
                                            <strong>
                                                {investigation.status ===
                                                "complete"
                                                    ? "Investigation complete"
                                                    : "Ready to investigate?"}
                                            </strong>
                                            <p>
                                                {investigation.status ===
                                                "complete"
                                                    ? `${investigation.tasks.length} task(s) were created from this investigation.`
                                                    : "The agent will only research and plan. Product code is changed later by task agents."}
                                            </p>
                                        </div>
                                        <button
                                            class="primary"
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
                                            }
                                        >
                                            {investigation.status === "complete"
                                                ? "Run again"
                                                : "Run investigation"}
                                        </button>
                                    </div>
                                    <Show when={investigation.findings}>
                                        <div class="investigation-findings p-[1.5rem] [&_h4]:m-0 [&_p]:m-[0.65rem_0_0]">
                                            <h4>Findings</h4>
                                            <p>{investigation.findings}</p>
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
