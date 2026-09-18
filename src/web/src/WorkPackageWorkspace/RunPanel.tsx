import {
    WORK_RUN_KIND_LABELS,
    type WorkPackageDetail,
    type WorkRunDetail,
    type WorkRunStatus,
} from "@shared/types"
import { action, createOptimistic, For, Show } from "solid-js"
import { api } from "../api"
import { StatusBadge } from "../components/StatusBadge"
import { useError } from "../hooks/useError"
import { TabHeading } from "./TabHeading"

const STATUS_LABELS: Record<WorkRunStatus, string> = {
    launched: "Opened in a terminal",
    running: "Running",
    finished: "Finished",
    stopped: "Stopped",
    blocked: "Needs attention",
    failed: "Failed",
}

const STATUS_TONES: Record<WorkRunStatus, string> = {
    launched: "info",
    running: "accent",
    finished: "success",
    stopped: "",
    blocked: "warning",
    failed: "error",
}

const ITEM_LABELS = {
    done: "Worked",
    working: "Working",
    waiting: "To work",
} as const

/**
 * One Run tab: what kind of run it is, how it is going, and the tasks it is
 * working through.
 */
export function RunPanel(props: {
    workPackage: WorkPackageDetail
    run: WorkRunDetail
    openTask: (ref: string) => void
    changed: () => void
}) {
    const [busy, setBusy] = createOptimistic("")
    const { capture, clear, Banner } = useError()
    const running = () => props.run.status === "running"
    const agent = () => props.run.agentRun

    const act = action(function* (
        label: string,
        request: () => Promise<unknown>,
    ) {
        if (busy()) return
        setBusy(label)
        clear()
        try {
            yield request()
            props.changed()
        } catch (caught) {
            capture(caught)
        }
    })

    const done = () =>
        props.run.items.filter((item) => item.state === "done").length

    return (
        <section class="mx-auto grid max-w-4xl gap-[1.1rem]">
            <TabHeading
                title={props.run.label}
                description={WORK_RUN_KIND_LABELS[props.run.kind]}
                rename={(label) =>
                    api.renameWorkRun(
                        props.workPackage.ref,
                        props.run.id,
                        label,
                    )
                }
                remove={
                    running()
                        ? undefined
                        : {
                              label: "Remove",
                              confirm: `Remove the '${props.run.label}' tab? The tasks it worked stay as they are.`,
                              run: () =>
                                  api.removeWorkRun(
                                      props.workPackage.ref,
                                      props.run.id,
                                  ),
                          }
                }
                changed={props.changed}>
                <span
                    class={`badge ${STATUS_TONES[props.run.status]} p-[0.3rem_0.7rem]`}
                    aria-busy={running() ? "true" : "false"}>
                    {STATUS_LABELS[props.run.status]}
                </span>
            </TabHeading>

            <Banner />
            <Show when={props.run.statusDetail}>
                <p class="notice warning m-0">{props.run.statusDetail}</p>
            </Show>

            <article class="tonal p-5">
                <dl class="m-0 grid gap-x-6 gap-y-3 sm:grid-cols-4 [&_dt]:text-xs [&_dt]:text-slate-400 [&_dd]:m-0 [&_dd]:text-sm">
                    <div>
                        <dt>Kind</dt>
                        <dd>{WORK_RUN_KIND_LABELS[props.run.kind]}</dd>
                    </div>
                    <div>
                        <dt>Agent</dt>
                        <dd class="font-mono">
                            {props.run.harness}
                            {props.run.model ? ` · ${props.run.model}` : ""}
                        </dd>
                    </div>
                    <div>
                        <dt>Launched</dt>
                        <dd>
                            {props.run.mode === "print"
                                ? "Headless"
                                : "In a terminal"}
                        </dd>
                    </div>
                    <div>
                        <dt>Started</dt>
                        <dd>
                            {new Date(props.run.createdAt).toLocaleString()}
                        </dd>
                    </div>
                </dl>
                <Show when={props.run.extra}>
                    <p class="hint mt-3 mb-0 whitespace-pre-wrap">
                        {props.run.extra}
                    </p>
                </Show>
                <div class="mt-4 flex flex-wrap gap-2">
                    <Show when={running()}>
                        <button
                            class="outlined"
                            aria-busy={busy() === "stop" ? "true" : "false"}
                            disabled={!!busy()}
                            onClick={() =>
                                act("stop", () =>
                                    api.stopWorkRun(
                                        props.workPackage.ref,
                                        props.run.id,
                                    ),
                                )
                            }>
                            Stop
                        </button>
                    </Show>
                    <Show when={agent()}>
                        {(current) => (
                            <button
                                class="outlined"
                                aria-busy={
                                    busy() === "resume" ? "true" : "false"
                                }
                                disabled={!!busy() || !current().sessionId}
                                title={
                                    current().sessionId
                                        ? `Reopen this ${current().harness} conversation in a terminal`
                                        : "This run has no recorded conversation ID to reopen."
                                }
                                onClick={() =>
                                    act("resume", () =>
                                        api.resumeAgentRun(current().id),
                                    )
                                }>
                                Resume in a terminal
                            </button>
                        )}
                    </Show>
                </div>
            </article>

            <article class="elevated p-5">
                <header class="flex items-baseline justify-between gap-3">
                    <h3 class="m-0">Tasks</h3>
                    <span class="caption muted">
                        {done()} of {props.run.items.length} worked
                    </span>
                </header>
                <ol
                    class="mt-4 grid gap-1 p-0"
                    style={{ "list-style": "none" }}>
                    <For
                        each={props.run.items}
                        fallback={
                            <li class="hint">This run had no tasks to work.</li>
                        }>
                        {(item, index) => (
                            <li>
                                <button
                                    class="card-item row compact flex w-full items-center gap-3 px-3 py-2 text-left"
                                    aria-current={
                                        item.state === "working"
                                            ? "step"
                                            : undefined
                                    }
                                    onClick={() => props.openTask(item.ref)}>
                                    <span class="w-5 text-right font-mono caption muted">
                                        {index() + 1}
                                    </span>
                                    <span class="font-mono caption muted w-12">
                                        {item.ref}
                                    </span>
                                    <span class="min-w-0 flex-1 truncate text-sm">
                                        {item.title}
                                    </span>
                                    <span
                                        class={`badge ${
                                            item.state === "done"
                                                ? "success"
                                                : item.state === "working"
                                                  ? "accent"
                                                  : ""
                                        } p-[0.12rem_0.42rem]`}
                                        aria-busy={
                                            item.state === "working" &&
                                            running()
                                                ? "true"
                                                : "false"
                                        }>
                                        {ITEM_LABELS[item.state]}
                                    </span>
                                    <Show when={item.status}>
                                        {(status) => (
                                            <StatusBadge status={status()} />
                                        )}
                                    </Show>
                                </button>
                            </li>
                        )}
                    </For>
                </ol>
            </article>
        </section>
    )
}
