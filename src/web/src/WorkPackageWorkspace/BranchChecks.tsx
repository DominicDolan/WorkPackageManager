import {
    action,
    createOptimistic,
    createSignal,
    For,
    onSettled,
    Show,
} from "solid-js"
import {
    MAX_SUPERVISIONS_PER_CHECK,
    checksSupervisionActive,
    type CheckRun,
    type ChecksSupervision,
    type CombinedBranchDetail,
    type RunSupervisor,
} from "@shared/types"
import { checkPassed } from "@shared/checks"
import { api } from "../api"
import { SupervisorPickerDialog } from "../components/SupervisorPickerDialog"
import { SupervisorRow } from "../components/SupervisorRow"

type CheckState = Pick<
    CombinedBranchDetail,
    "checks" | "checksRunning" | "checksSupervision"
>

/** Why a supervised run stopped, when that is worth a notice. */
const supervisionEnded: Partial<Record<ChecksSupervision["status"], string>> = {
    blocked: "The supervisor stopped",
    failed: "The supervised run failed",
    stopped: "The supervised run was stopped",
}

const labels: Record<CheckRun["status"], string> = {
    passed: "Passed",
    failed: "Failed",
    skipped: "Skipped",
    timed_out: "Timed out",
    error: "Error",
}
const seconds = (ms: number) => `${(Math.max(0, ms) / 1000).toFixed(1)}s`

export function BranchChecks(props: {
    branch: CombinedBranchDetail
    names: string[]
    disabled: boolean
    stale: boolean
    updated: (state: CheckState) => void
    investigate: () => void
}) {
    const [requesting, setRequesting] = createOptimistic(false)
    const [requestedCheck, setRequestedCheck] = createOptimistic<string | null>(
        null,
    )
    const [error, setError] = createSignal("")
    const [pollError, setPollError] = createSignal(false)
    const [now, setNow] = createSignal(Date.now())
    const progress = () => props.branch.checksRunning
    const report = () => props.branch.checks
    const supervision = () => props.branch.checksSupervision
    const supervising = () => checksSupervisionActive(supervision())
    const fixing = () =>
        supervision()?.status === "fixing"
            ? supervision()!.agents.at(-1)
            : undefined
    const ended = () => {
        const last = supervision()
        return last && supervisionEnded[last.status] ? last : null
    }
    const [choosingSupervisor, setChoosingSupervisor] = createSignal(false)
    const [stopping, setStopping] = createSignal(false)
    const busy = () => requesting() || !!progress() || supervising()
    const disabled = () => props.disabled || busy() || !props.branch.git.exists
    const result = (name: string) =>
        (progress()?.checks ?? report()?.checks)?.find(
            (run) => run.name === name,
        )
    const remaining = () =>
        props.names.filter((name) => {
            const run = report()?.checks.find((run) => run.name === name)
            return !run || !checkPassed(run)
        })
    const failed = () => report()?.checks.some((run) => !checkPassed(run))
    // Invalidate any read that was started before a new run was requested.
    let generation = 0
    let disposed = false
    const start = action(async function* (
        check?: string,
        resume = false,
        from?: string,
    ) {
        if (disabled()) return
        generation++
        setRequesting(true)
        setRequestedCheck(
            from ?? check ?? (resume ? remaining()[0] : props.names[0]) ?? null,
        )
        setError("")
        try {
            const branch = await api.runChecks(
                props.branch.branchName,
                check,
                resume,
                from,
            )
            yield
            if (!disposed) {
                setNow(Date.now())
                props.updated({
                    checks: branch.checks,
                    checksRunning: branch.checksRunning,
                    checksSupervision: branch.checksSupervision,
                })
            }
        } catch (caught) {
            yield
            if (!disposed)
                setError(
                    caught instanceof Error ? caught.message : String(caught),
                )
        }
    })

    // Failures reach the dialog, which shows them where the choice was made.
    const startSupervised = async (supervisor: RunSupervisor) => {
        generation++
        const branch = await api.runChecksWithSupervisor(
            props.branch.branchName,
            supervisor,
            !!report() && remaining().length > 0,
        )
        if (disposed) return
        setError("")
        setNow(Date.now())
        props.updated({
            checks: branch.checks,
            checksRunning: branch.checksRunning,
            checksSupervision: branch.checksSupervision,
        })
    }

    const stopSupervisor = async () => {
        if (stopping()) return
        generation++
        setStopping(true)
        setError("")
        try {
            const branch = await api.stopChecksSupervisor(
                props.branch.branchName,
            )
            if (!disposed)
                props.updated({
                    checks: branch.checks,
                    checksRunning: branch.checksRunning,
                    checksSupervision: branch.checksSupervision,
                })
        } catch (caught) {
            if (!disposed)
                setError(
                    caught instanceof Error ? caught.message : String(caught),
                )
        } finally {
            if (!disposed) setStopping(false)
        }
    }

    onSettled(() => {
        let reading = false
        let lastRead = 0
        const tick = setInterval(() => {
            if (progress()) setNow(Date.now())
            // Slow idle polling also discovers runs started in another tab.
            if (
                !props.names.length ||
                reading ||
                requesting() ||
                Date.now() - lastRead <
                    (progress() || supervising() ? 1000 : 5000)
            )
                return
            reading = true
            lastRead = Date.now()
            const version = generation
            const name = props.branch.branchName
            api.getChecks(name)
                .then((state) => {
                    if (
                        disposed ||
                        version !== generation ||
                        name !== props.branch.branchName
                    )
                        return
                    props.updated(state)
                    setPollError(false)
                })
                .catch(() => {
                    if (!disposed && version === generation) setPollError(true)
                })
                .finally(() => {
                    reading = false
                })
        }, 250)
        return () => {
            disposed = true
            clearInterval(tick)
        }
    })

    return (
        <div class="check-report">
            <div class="branch-section-actions flex flex-wrap items-center gap-[0.75rem]">
                <button
                    class="outlined"
                    disabled={disabled() || !props.names.length}
                    aria-busy={busy() ? "true" : "false"}
                    onClick={() => start()}>
                    {report() ? "Run all again" : "Run all checks"}
                </button>
                <Show when={report() && remaining().length > 0}>
                    <button
                        class="primary"
                        disabled={disabled()}
                        title="Retry failed checks, then run checks that have not run. Successful checks are kept for the same commit."
                        onClick={() => start(undefined, true)}>
                        Resume checks
                    </button>
                </Show>
                <Show
                    when={supervising()}
                    fallback={
                        <button
                            class="outlined"
                            disabled={disabled() || !props.names.length}
                            title="Run the checks with an agent standing by to fix and commit each failure, then resume."
                            onClick={() => setChoosingSupervisor(true)}>
                            Run with supervisor
                        </button>
                    }>
                    <button
                        class="outlined"
                        aria-busy={stopping() ? "true" : "false"}
                        disabled={stopping()}
                        title="Stop the supervisor. A check already running finishes, but nothing follows it."
                        onClick={stopSupervisor}>
                        Stop supervisor
                    </button>
                </Show>
                <Show when={failed()}>
                    <button
                        class="outlined check-agent-button ml-auto"
                        disabled={props.disabled || busy()}
                        onClick={props.investigate}>
                        Investigate with agent
                    </button>
                </Show>
            </div>
            <p
                class="hint check-progress m-[1rem_0_0] min-h-[2.5rem]"
                role="status">
                {requesting()
                    ? "Starting checks…"
                    : fixing()
                      ? `The supervisor is fixing ${fixing()!.check}. The checks resume when it finishes. You can leave this page.`
                      : progress()
                        ? `${supervising() ? "Supervised · " : ""}${progress()!.done} of ${progress()!.total} complete · ${progress()!.current ? `Running ${progress()!.current}` : "Finishing checks"}. You can leave this page.`
                        : !props.names.length
                          ? "No pre-PR checks are configured for this repository."
                          : !report()
                            ? "Checks have not been run on this branch yet."
                            : remaining().length
                              ? `${failed() ? "Paused after a failed check." : "Checks incomplete."} ${remaining().length} check(s) remaining. Resume when ready.`
                              : "All checks passed."}
            </p>
            <Show when={error()}>
                <p class="notice warning" role="alert">
                    {error()}
                </p>
            </Show>
            <Show when={ended()}>
                {(ended) => (
                    <p class="notice warning" role="status">
                        {supervisionEnded[ended().status]}
                        {ended().stopReason ? `: ${ended().stopReason}` : "."}
                    </p>
                )}
            </Show>
            <Show when={pollError()}>
                <p class="notice warning" role="status">
                    Unable to refresh check progress. Retrying…
                </p>
            </Show>
            <Show when={props.stale && !busy()}>
                <p class="notice warning">
                    The branch has new commits. Run the checks again for the new
                    commit; Resume will also rerun the full suite.
                </p>
            </Show>
            <Show when={props.names.length > 0}>
                <ul class="branch-checks overflow-hidden m-[0.5rem_0_0] p-0">
                    <For each={props.names}>
                        {(name) => {
                            const running = () =>
                                (progress()?.current ?? requestedCheck()) ===
                                name
                            const outputResult = () =>
                                result(name) ??
                                (running()
                                    ? report()?.checks.find(
                                          (run) => run.name === name,
                                      )
                                    : undefined)
                            const queued = () =>
                                !!progress()?.names.includes(name) &&
                                !result(name) &&
                                !running()
                            const status = () =>
                                running()
                                    ? "running"
                                    : queued()
                                      ? "queued"
                                      : (result(name)?.status ?? "not-run")
                            const duration = () =>
                                running() && progress()
                                    ? seconds(
                                          now() -
                                              Date.parse(
                                                  progress()!
                                                      .currentStartedAt ??
                                                      progress()!.startedAt,
                                              ),
                                      )
                                    : result(name)
                                      ? seconds(result(name)!.durationMs)
                                      : "—"
                            const supervisors = () =>
                                supervision()?.agents.filter(
                                    (agent) => agent.check === name,
                                ) ?? []
                            return (
                                <>
                                    <li
                                        class="check-row flex items-start max-[700px]:flex-wrap"
                                        aria-busy={
                                            running() ? "true" : "false"
                                        }>
                                        <details class="min-w-0 flex-1 max-[700px]:basis-full">
                                            <summary class="grid min-h-[3.4rem] grid-cols-[6rem_minmax(7rem,_1fr)_minmax(0,_2fr)_5.5rem] items-center gap-[0.7rem] p-[0.7rem_0.8rem] max-[560px]:grid-cols-[5rem_minmax(0,_1fr)_4.5rem]">
                                                <span
                                                    class="badge inline-flex items-center justify-center p-[0.18rem_0.5rem]"
                                                    data-status={status()}>
                                                    {running()
                                                        ? "Running"
                                                        : queued()
                                                          ? "Queued"
                                                          : result(name)
                                                            ? labels[
                                                                  result(name)!
                                                                      .status
                                                              ]
                                                            : "Not run"}
                                                </span>
                                                <strong class="break-words">
                                                    {name}
                                                </strong>
                                                <code class="overflow-hidden max-[560px]:col-[2_/_-1] max-[560px]:row-[2]">
                                                    {outputResult()?.command.join(
                                                        " ",
                                                    ) ?? ""}
                                                </code>
                                                <span
                                                    class="text-right tabular-nums"
                                                    role={
                                                        running()
                                                            ? "timer"
                                                            : undefined
                                                    }
                                                    aria-label={`${name} elapsed time`}>
                                                    {duration()}
                                                </span>
                                            </summary>
                                            <Show
                                                when={
                                                    running() && outputResult()
                                                }>
                                                <p class="m-0 p-[0_0.8rem_0.7rem]">
                                                    Previous result. New output
                                                    will appear when this check
                                                    finishes.
                                                </p>
                                            </Show>
                                            <Show when={outputResult()?.reason}>
                                                <p class="m-0 p-[0_0.8rem_0.7rem]">
                                                    {outputResult()?.reason}
                                                </p>
                                            </Show>
                                            <Show when={outputResult()?.output}>
                                                <pre class="max-h-[26rem] m-0 overflow-auto p-[0.9rem]">
                                                    {outputResult()?.output}
                                                </pre>
                                            </Show>
                                            <Show when={!outputResult()}>
                                                <p class="m-0 p-[0_0.8rem_0.7rem]">
                                                    {running()
                                                        ? "Output will appear when this check finishes."
                                                        : "No result yet."}
                                                </p>
                                            </Show>
                                        </details>
                                        <div class="flex flex-wrap justify-end gap-[0.4rem] m-[0.45rem_0.7rem_0.45rem_0] max-[700px]:ml-auto">
                                            <button
                                                class="outlined check-run-button flex-[0_0_auto]"
                                                disabled={disabled()}
                                                aria-label={`Run ${name}`}
                                                onClick={() => start(name)}>
                                                Run
                                            </button>
                                            <button
                                                class="outlined check-run-button flex-[0_0_auto]"
                                                disabled={disabled()}
                                                aria-label={`Run from ${name}`}
                                                title="Run this check and the checks below it"
                                                onClick={() =>
                                                    start(
                                                        undefined,
                                                        false,
                                                        name,
                                                    )
                                                }>
                                                Run from here
                                            </button>
                                        </div>
                                    </li>
                                    <For each={supervisors()}>
                                        {(agent) => (
                                            <li class="p-[0.4rem_0.7rem]">
                                                <SupervisorRow
                                                    agent={agent}
                                                    afterResolved="It committed a fix, so the check ran again against the new commit."
                                                    afterUnresolved="The checks stopped here for a person."
                                                />
                                            </li>
                                        )}
                                    </For>
                                </>
                            )
                        }}
                    </For>
                </ul>
            </Show>
            <Show when={choosingSupervisor()}>
                <SupervisorPickerDialog
                    title="Run checks with a supervisor"
                    description={`When a check fails, the supervisor is sent the failure to fix and commit, and then the checks resume. A new commit means the whole suite runs again. It is called in at most ${MAX_SUPERVISIONS_PER_CHECK} times per check before the run stops and waits for you.`}
                    action="Run checks"
                    previous={supervision()?.supervisor ?? null}
                    close={() => setChoosingSupervisor(false)}
                    start={startSupervised}
                />
            </Show>
            <p class="hint m-[0.75rem_0_0] min-h-[1.25rem]">
                {report()
                    ? `Last report: ${new Date(report()!.ranAt).toLocaleString()} · against ${report()!.base}`
                    : ""}
            </p>
        </div>
    )
}
