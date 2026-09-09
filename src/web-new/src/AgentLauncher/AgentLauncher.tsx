import { Loading, Show, createMemo, createSignal } from "solid-js"
import {
  nextWorkableTask,
  type AgentPermissionMode,
  type AgentRunMode,
  type Task,
  type TaskGroupDetail,
} from "@shared/types"
import { api } from "../../../web/api"
import { AgentSettings } from "../components/AgentSettings"
import { Modal } from "../components/Modal"

export function AgentLauncher(props: {
  group: TaskGroupDetail
  task?: Task
  close: () => void
  finished: () => void
}) {
  type RunChoice = "task" | "guided-group" | "unattended"
  const initial: RunChoice = props.task ? "task" : "guided-group"
  const [choice, setChoice] = createSignal<RunChoice>(initial)
  const environment = createMemo(() => api.agentEnvironment())
  const [harness, setHarness] = createSignal("codex")
  const [model, setModel] = createSignal("")
  const [mode, setMode] = createSignal<AgentRunMode>("terminal")
  const [permission, setPermission] =
    createSignal<AgentPermissionMode>("manual")
  const [extra, setExtra] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal("")

  const chosenHarness = () =>
    harness() ||
    environment().harnesses.find((item) => item.available)?.id ||
    ""

  const next = () => props.task ?? nextWorkableTask(props.group)
  const run = async () => {
    setBusy(true)
    setError("")
    try {
      const selectedHarness = chosenHarness()
      if (!selectedHarness)
        throw new Error("No supported agent harness is installed.")
      if (choice() === "unattended") {
        await api.startGroupRun(props.group.ref, {
          harness: selectedHarness,
          model: model(),
          permissionMode:
            permission() === "manual" ? "bypassPermissions" : permission(),
          extra: extra(),
          excluded: [],
        })
      } else {
        const task = next()
        const target = choice() === "task" ? task?.ref : props.group.ref
        if (!target) throw new Error("There is no task ready to work.")
        await api.startAgentRun({
          harness: selectedHarness,
          model: model(),
          mode:
            mode() === "terminal" && !environment().terminalAvailable
              ? "print"
              : mode(),
          command: choice() === "task" ? "work-task" : "work-group",
          target,
          extra: extra(),
          subjectKind: choice() === "task" ? "task" : "group",
          subjectRef: choice() === "task" ? target : props.group.ref,
          permissionMode: permission(),
        })
      }
      props.finished()
      props.close()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title="Work with an agent" close={props.close}>
      <div class="grid gap-3 sm:grid-cols-3">
        <RunChoice
          selected={choice() === "task"}
          title={props.task ? `Work ${props.task.ref}` : "Work next task"}
          detail="One task, then stop for review."
          onClick={() => setChoice("task")}
        />
        <RunChoice
          selected={choice() === "guided-group"}
          title="Guided group run"
          detail="One agent works the whole group."
          onClick={() => setChoice("guided-group")}
        />
        <RunChoice
          selected={choice() === "unattended"}
          title="Unattended group"
          detail="A fresh headless agent per task."
          onClick={() => setChoice("unattended")}
        />
      </div>

      <Loading
        fallback={
          <p class="mt-5 text-sm text-slate-500">Checking installed agents…</p>
        }
      >
        <AgentSettings
          environment={environment()}
          harness={chosenHarness()}
          setHarness={setHarness}
          model={model()}
          setModel={setModel}
          mode={mode()}
          setMode={setMode}
          permission={permission()}
          setPermission={setPermission}
          unattended={choice() === "unattended"}
        />
      </Loading>

      <label class="field mt-4">
        <span>Extra instructions</span>
        <textarea
          value={extra()}
          onInput={(event) => setExtra(event.currentTarget.value)}
          placeholder="Optional context for the agent…"
        />
      </label>
      <Show when={error()}>
        <p class="banner mt-4">{error()}</p>
      </Show>
      <div class="mt-5 flex justify-end">
        <button class="button-primary" disabled={busy()} onClick={run}>
          {busy() ? "Starting…" : "Start run"}
        </button>
      </div>
    </Modal>
  )
}

function RunChoice(props: {
  selected: boolean
  title: string
  detail: string
  onClick: () => void
}) {
  return (
    <button
      class={`rounded-xl border p-4 text-left transition ${props.selected ? "border-blue-500 bg-blue-50 ring-2 ring-blue-100" : "border-slate-200 hover:border-slate-300"}`}
      onClick={props.onClick}
    >
      <strong class="block text-sm">{props.title}</strong>
      <span class="mt-1 block text-xs leading-5 text-slate-500">
        {props.detail}
      </span>
    </button>
  )
}
