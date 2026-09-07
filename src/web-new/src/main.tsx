import {
  Errored,
  For,
  Loading,
  Show,
  createMemo,
  createSignal,
  onSettled,
  refresh,
  type Element,
} from 'solid-js';
import { render } from '@solidjs/web';
import {
  AGENT_PERMISSION_MODE_LABELS,
  GROUP_COLORS,
  GROUP_RUN_STATUS_LABELS,
  ISSUE_SOURCE_LABELS,
  INVESTIGATION_STATUS_LABELS,
  STATUS_LABELS,
  STATUSES,
  groupRunActive,
  nextWorkableTask,
  type AgentEnvironment,
  type AgentModel,
  type AgentPermissionMode,
  type AgentRunMode,
  type CombinedBranchDetail,
  type Investigation,
  type InvestigationDetail,
  type IssueDetail,
  type IssueState,
  type IssueSummary,
  type Note,
  type NotesWorkspaceInfo,
  type Priority,
  type Status,
  type Task,
  type TaskDetail,
  type TaskGroupDetail,
  type TaskGroupSummary,
  type VisualComparison,
} from '@shared/types';
import { api, imageUrl, noteAssetUrl, taskAssetUrl } from '../../web/api';
import { renderMarkdown } from '../../web/markdown';
import './styles.css';

const UNGROUPED_REF = '__ungrouped__';

const statusStyles: Record<Status, string> = {
  backlog: 'status-backlog',
  in_progress: 'status-progress',
  dev_complete: 'status-review',
  verified: 'status-verified',
  closed: 'status-closed',
};

interface WorkspaceSnapshot {
  groups: TaskGroupSummary[];
  tasks: Task[];
  investigations: Investigation[];
  branches: CombinedBranchDetail[];
  aioVrReady: boolean;
}

async function loadWorkspace(): Promise<WorkspaceSnapshot> {
  const [groups, tasks, investigations, branchResult, meta] = await Promise.all([
    api.listGroups(),
    api.listTasks(),
    api.listInvestigations(),
    api.listBranches(),
    api.meta(),
  ]);
  return {
    groups,
    tasks,
    investigations,
    branches: branchResult.branches,
    aioVrReady: meta.aioVrInstalled && meta.aioVrWorkspaceExists,
  };
}

function StatusBadge(props: { status: Status }) {
  return (
    <span class={`status-badge ${statusStyles[props.status]}`}>
      {STATUS_LABELS[props.status]}
    </span>
  );
}

function Brand(props: { compact?: boolean }) {
  return (
    <div class={`brand ${props.compact ? 'brand-compact' : ''}`}>
      <svg class="brand-mark" viewBox="0 0 36 36" aria-hidden="true">
        <path d="M7 5h15v5H12v16h10v5H7z" />
        <path class="brand-signal" d="M19 14h10v10H19z" />
      </svg>
      <Show when={!props.compact}>
        <span class="brand-name">Worktask</span>
      </Show>
    </div>
  );
}

function BackIcon() {
  return <svg class="ui-icon" viewBox="0 0 20 20" aria-hidden="true"><path d="m11.8 4.7-5.3 5.3 5.3 5.3M6.8 10h7" /></svg>;
}

function PlusIcon() {
  return <svg class="ui-icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4v12M4 10h12" /></svg>;
}

type MainView = 'groups' | 'notes' | 'issues';

function ProductRail(props: { active: MainView; select: (view: MainView) => void }) {
  return (
    <aside class="product-rail">
      <Brand />
      <nav class="rail-nav" aria-label="Primary navigation">
        <button class={`rail-link ${props.active === 'groups' ? 'rail-link-active' : ''}`} aria-current={props.active === 'groups' ? 'page' : undefined} onClick={() => props.select('groups')}><Show when={props.active === 'groups'}><span class="rail-indicator" /></Show>Groups</button>
        <button class={`rail-link ${props.active === 'notes' ? 'rail-link-active' : ''}`} aria-current={props.active === 'notes' ? 'page' : undefined} onClick={() => props.select('notes')}><Show when={props.active === 'notes'}><span class="rail-indicator" /></Show>Notes</button>
        <button class={`rail-link ${props.active === 'issues' ? 'rail-link-active' : ''}`} aria-current={props.active === 'issues' ? 'page' : undefined} onClick={() => props.select('issues')}><Show when={props.active === 'issues'}><span class="rail-indicator" /></Show>Issues</button>
      </nav>
      <div class="rail-note">
        <span>Workspace flow</span>
        <p>Investigate.<br />Build. Verify. Ship.</p>
      </div>
      <p class="rail-version">Local workspace</p>
    </aside>
  );
}

function Modal(props: { title: string; close: () => void; children: Element }) {
  return (
    <div class="modal-scrim fixed inset-0 z-50 grid place-items-center p-4" onMouseDown={event => event.currentTarget === event.target && props.close()}>
      <section class="modal-panel max-h-[92vh] w-full max-w-2xl overflow-auto bg-white p-6" role="dialog" aria-modal="true">
        <header class="mb-5 flex items-center justify-between gap-4">
          <h2 class="text-xl font-semibold tracking-tight">{props.title}</h2>
          <button class="button" onClick={props.close}>Close</button>
        </header>
        {props.children}
      </section>
    </div>
  );
}

function AgentLauncher(props: {
  group: TaskGroupDetail;
  task?: Task;
  close: () => void;
  finished: () => void;
}) {
  type RunChoice = 'task' | 'guided-group' | 'unattended';
  const initial: RunChoice = props.task ? 'task' : 'guided-group';
  const [choice, setChoice] = createSignal<RunChoice>(initial);
  const environment = createMemo(() => api.agentEnvironment());
  const [harness, setHarness] = createSignal('codex');
  const [model, setModel] = createSignal('');
  const [mode, setMode] = createSignal<AgentRunMode>('terminal');
  const [permission, setPermission] = createSignal<AgentPermissionMode>('manual');
  const [extra, setExtra] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');

  const chosenHarness = () => harness() || environment().harnesses.find(item => item.available)?.id || '';
  const models = createMemo(async (): Promise<AgentModel[]> => {
    const id = chosenHarness();
    return id ? api.agentModels(id) : [];
  });

  const next = () => props.task ?? nextWorkableTask(props.group);
  const run = async () => {
    setBusy(true);
    setError('');
    try {
      const selectedHarness = chosenHarness();
      if (!selectedHarness) throw new Error('No supported agent harness is installed.');
      if (choice() === 'unattended') {
        await api.startGroupRun(props.group.ref, {
          harness: selectedHarness,
          model: model(),
          permissionMode: permission() === 'manual' ? 'bypassPermissions' : permission(),
          extra: extra(),
          excluded: [],
        });
      } else {
        const task = next();
        const target = choice() === 'task' ? task?.ref : props.group.ref;
        if (!target) throw new Error('There is no task ready to work.');
        await api.startAgentRun({
          harness: selectedHarness,
          model: model(),
          mode: mode() === 'terminal' && !environment().terminalAvailable ? 'print' : mode(),
          command: choice() === 'task' ? 'work-task' : 'work-group',
          target,
          extra: extra(),
          subjectKind: choice() === 'task' ? 'task' : 'group',
          subjectRef: choice() === 'task' ? target : props.group.ref,
          permissionMode: permission(),
        });
      }
      props.finished();
      props.close();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Work with an agent" close={props.close}>
      <div class="grid gap-3 sm:grid-cols-3">
        <RunChoice selected={choice() === 'task'} title={props.task ? `Work ${props.task.ref}` : 'Work next task'} detail="One task, then stop for review." onClick={() => setChoice('task')} />
        <RunChoice selected={choice() === 'guided-group'} title="Guided group run" detail="One agent works the whole group." onClick={() => setChoice('guided-group')} />
        <RunChoice selected={choice() === 'unattended'} title="Unattended group" detail="A fresh headless agent per task." onClick={() => setChoice('unattended')} />
      </div>

      <Loading fallback={<p class="mt-5 text-sm text-slate-500">Checking installed agents…</p>}>
        <AgentSettings
          environment={environment()}
          harness={chosenHarness()}
          setHarness={setHarness}
          model={model()}
          setModel={setModel}
          models={models()}
          mode={mode()}
          setMode={setMode}
          permission={permission()}
          setPermission={setPermission}
          unattended={choice() === 'unattended'}
        />
      </Loading>

      <label class="field mt-4">
        <span>Extra instructions</span>
        <textarea value={extra()} onInput={event => setExtra(event.currentTarget.value)} placeholder="Optional context for the agent…" />
      </label>
      <Show when={error()}><p class="banner mt-4">{error()}</p></Show>
      <div class="mt-5 flex justify-end">
        <button class="button-primary" disabled={busy()} onClick={run}>
          {busy() ? 'Starting…' : 'Start run'}
        </button>
      </div>
    </Modal>
  );
}

function InvestigationLauncher(props: { investigation: Investigation; close: () => void; started: () => void }) {
  const environment = createMemo(() => api.agentEnvironment());
  const [harness, setHarness] = createSignal('codex');
  const [model, setModel] = createSignal('');
  const [mode, setMode] = createSignal<AgentRunMode>('terminal');
  const [permission, setPermission] = createSignal<AgentPermissionMode>('manual');
  const [extra, setExtra] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  const chosenHarness = () => harness() || environment().harnesses.find(item => item.available)?.id || '';
  const models = createMemo(async (): Promise<AgentModel[]> => chosenHarness() ? api.agentModels(chosenHarness()) : []);
  const run = async () => {
    setBusy(true); setError('');
    try {
      if (!chosenHarness()) throw new Error('No supported agent harness is installed.');
      await api.startAgentRun({
        harness: chosenHarness(), model: model(),
        mode: mode() === 'terminal' && !environment().terminalAvailable ? 'print' : mode(),
        command: 'plan-tasks', target: props.investigation.ref, extra: extra(),
        subjectKind: 'investigation', subjectRef: props.investigation.ref, permissionMode: permission(),
      });
      props.started(); props.close();
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setBusy(false); }
  };
  return <Modal title="Run investigation" close={props.close}>
    <div class="investigation-run-summary"><span>{props.investigation.ref}</span><strong>{props.investigation.title}</strong><p>The agent will investigate this brief, record its findings, and create tasks in the linked group. It will not change product code.</p></div>
    <Loading fallback={<p class="mt-5 text-sm text-slate-500">Checking installed agents…</p>}><AgentSettings environment={environment()} harness={chosenHarness()} setHarness={setHarness} model={model()} setModel={setModel} models={models()} mode={mode()} setMode={setMode} permission={permission()} setPermission={setPermission} unattended={false} /></Loading>
    <label class="field mt-4"><span>Extra instructions</span><textarea value={extra()} onInput={event => setExtra(event.currentTarget.value)} placeholder="Optional context for this run" /></label>
    <Show when={error()}><p class="banner mt-4">{error()}</p></Show>
    <div class="mt-5 flex justify-end"><button class="button-primary" disabled={busy()} onClick={run}>{busy() ? 'Starting…' : 'Start investigation'}</button></div>
  </Modal>;
}

function RunChoice(props: { selected: boolean; title: string; detail: string; onClick: () => void }) {
  return (
    <button class={`rounded-xl border p-4 text-left transition ${props.selected ? 'border-blue-500 bg-blue-50 ring-2 ring-blue-100' : 'border-slate-200 hover:border-slate-300'}`} onClick={props.onClick}>
      <strong class="block text-sm">{props.title}</strong>
      <span class="mt-1 block text-xs leading-5 text-slate-500">{props.detail}</span>
    </button>
  );
}

function AgentSettings(props: {
  environment: AgentEnvironment;
  harness: string;
  setHarness: (value: string) => void;
  model: string;
  setModel: (value: string) => void;
  models: AgentModel[];
  mode: AgentRunMode;
  setMode: (value: AgentRunMode) => void;
  permission: AgentPermissionMode;
  setPermission: (value: AgentPermissionMode) => void;
  unattended: boolean;
}) {
  const available = () => props.environment.harnesses.filter(item => item.available);
  return (
    <div class="mt-5 grid gap-4 sm:grid-cols-2">
      <label class="field">
        <span>Agent</span>
        <select value={props.harness} onChange={event => props.setHarness(event.currentTarget.value)}>
          <For each={available()}>{item => <option value={item.id}>{item.label}</option>}</For>
        </select>
      </label>
      <ModelPicker models={props.models} value={props.model} setValue={props.setModel} />
      <Show when={!props.unattended}>
        <label class="field">
          <span>Run mode</span>
          <select value={props.mode} onChange={event => props.setMode(event.currentTarget.value as AgentRunMode)}>
            <option value="terminal" disabled={!props.environment.terminalAvailable}>Interactive terminal</option>
            <option value="print">Headless log</option>
          </select>
        </label>
      </Show>
      <label class="field">
        <span>Permissions</span>
        <select value={props.unattended && props.permission === 'manual' ? 'bypassPermissions' : props.permission} onChange={event => props.setPermission(event.currentTarget.value as AgentPermissionMode)}>
          <For each={Object.entries(AGENT_PERMISSION_MODE_LABELS)}>
            {([value, label]) => <option value={value}>{label}</option>}
          </For>
        </select>
      </label>
    </div>
  );
}

function ModelPicker(props: { models: AgentModel[]; value: string; setValue: (value: string) => void }) {
  const selected = () => props.models.find(item => item.id === props.value);
  const [query, setQuery] = createSignal('');
  const [open, setOpen] = createSignal(false);
  const filtered = () => {
    const needle = query().trim().toLowerCase();
    const choices = props.models.filter(item => item.id);
    return (needle
      ? choices.filter(item => `${item.label} ${item.id} ${item.group ?? ''}`.toLowerCase().includes(needle))
      : choices
    ).slice(0, 80);
  };
  const choose = (entry?: AgentModel) => {
    props.setValue(entry?.id ?? '');
    setQuery(entry?.label ?? '');
    setOpen(false);
  };
  return (
    <label class="field relative">
      <span>Model</span>
      <input
        role="combobox"
        aria-expanded={open() ? 'true' : 'false'}
        value={open() ? query() : selected()?.label ?? query()}
        placeholder={props.models.length ? 'Search models…' : 'Harness default'}
        onFocus={() => { setQuery(selected()?.label ?? ''); setOpen(true); }}
        onInput={event => { setQuery(event.currentTarget.value); setOpen(true); if (!event.currentTarget.value) props.setValue(''); }}
        onKeyDown={event => { if (event.key === 'Escape') setOpen(false); }}
      />
      <Show when={open()}>
        <div class="absolute left-0 right-0 top-full z-20 mt-1 max-h-64 overflow-auto rounded-xl border border-slate-200 bg-white p-1 shadow-2xl">
          <button type="button" class="model-option" onMouseDown={event => event.preventDefault()} onClick={() => choose()}>
            <span>Harness default</span>
          </button>
          <For each={filtered()} fallback={<p class="px-3 py-5 text-center text-xs text-slate-500">No matching models.</p>}>
            {entry => <button type="button" class="model-option" onMouseDown={event => event.preventDefault()} onClick={() => choose(entry)}><span class="truncate">{entry.label}</span><small>{entry.group ?? entry.id}</small></button>}
          </For>
        </div>
      </Show>
    </label>
  );
}

function CreateGroup(props: {
  close: () => void;
  created: (ref: string) => void;
}) {
  const [name, setName] = createSignal('');
  const [description, setDescription] = createSignal('');
  const [color, setColor] = createSignal<string>(GROUP_COLORS[0]);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      const result = await api.createGroup({
        name: name(),
        description: description(),
        investigation: description(),
        color: color(),
      });
      props.created(result.group.ref);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Create group" close={props.close}>
      <p class="modal-intro">Define the outcome, then give an agent the question and context it needs to investigate. The tasks it creates will be filed into this group.</p>
      <label class="field mt-4"><span>Group name</span><input autofocus value={name()} onInput={event => setName(event.currentTarget.value)} placeholder="e.g. Improve release confidence" /></label>
      <label class="field mt-4"><span>Investigation</span><textarea value={description()} onInput={event => setDescription(event.currentTarget.value)} placeholder="What should the agent investigate? Include the problem, context and any constraints." /></label>
      <div class="mt-4">
        <span class="field-label">Colour</span>
        <div class="mt-2 flex gap-2">
          <For each={GROUP_COLORS}>{value => (
            <button aria-label={value} class={`h-8 w-8 rounded-full ring-offset-2 ${color() === value ? 'ring-2 ring-slate-700' : ''}`} style={{ background: value }} onClick={() => setColor(value)} />
          )}</For>
        </div>
      </div>
      <Show when={error()}><p class="banner mt-4">{error()}</p></Show>
      <div class="mt-5 flex justify-end gap-2"><button class="button" onClick={props.close}>Cancel</button><button class="button-primary" disabled={!name().trim() || busy()} onClick={submit}>{busy() ? 'Creating…' : 'Create group'}</button></div>
    </Modal>
  );
}

function GroupHome(props: {
  snapshot: WorkspaceSnapshot;
  open: (ref: string) => void;
  create: () => void;
  select: (view: MainView) => void;
}) {
  const loose = () => props.snapshot.tasks.filter(task => !task.groupRef);
  const active = () => props.snapshot.tasks.filter(task => task.status === 'in_progress').length;
  const review = () => props.snapshot.tasks.filter(task => task.status === 'dev_complete').length;
  // These timestamps are retained when a task subsequently moves on, which is
  // exactly the activity signal the portfolio needs: the most recently started
  // or completed group should remain at the top.
  const groupsByRecentWork = () => {
    const recentWork = new Map<string, string>();
    for (const task of props.snapshot.tasks) {
      if (!task.groupRef) continue;
      const at = [task.startedAt, task.devCompletedAt].reduce<string | null>(
        (latest, timestamp) => !timestamp || (latest && latest >= timestamp) ? latest : timestamp,
        null,
      );
      if (at && (!recentWork.has(task.groupRef) || recentWork.get(task.groupRef)! < at)) {
        recentWork.set(task.groupRef, at);
      }
    }

    return [...props.snapshot.groups].sort((left, right) => {
      const leftAt = recentWork.get(left.ref);
      const rightAt = recentWork.get(right.ref);
      if (leftAt && rightAt) return rightAt.localeCompare(leftAt);
      if (leftAt) return -1;
      if (rightAt) return 1;
      return 0;
    });
  };
  return (
    <main class="app-shell min-h-screen text-slate-950">
      <ProductRail active="groups" select={props.select} />
      <section class="work-surface">
        <header class="portfolio-header">
          <div class="portfolio-copy">
            <p class="eyebrow">Engineering operations</p>
            <h1>Work in motion</h1>
            <p>Plan grouped changes, direct agents, and keep the evidence needed to ship with confidence.</p>
          </div>
          <button class="button-primary header-action" onClick={props.create}><PlusIcon />New group</button>
          <dl class="portfolio-stats">
            <div><dt>Groups</dt><dd>{props.snapshot.groups.length}</dd></div>
            <div><dt>In progress</dt><dd>{active()}</dd></div>
            <div><dt>Ready to review</dt><dd>{review()}</dd></div>
          </dl>
        </header>
        <div class="ledger-heading">
          <div><h2>Portfolio</h2><p>{props.snapshot.tasks.length} tasks across the workspace</p></div>
          <span>Open work / total</span>
        </div>
        <div class="group-ledger">
          <For each={groupsByRecentWork()}>
            {group => <GroupCard group={group} tasks={props.snapshot.tasks.filter(task => task.groupRef === group.ref)} open={() => props.open(group.ref)} />}
          </For>
          <Show when={loose().length}>
            <GroupCard
              group={{ ref: UNGROUPED_REF, name: 'Ungrouped', description: 'Legacy tasks created before group membership became mandatory.', color: '#94a3b8', taskCount: loose().length, openCount: loose().filter(task => task.status !== 'closed').length } as TaskGroupSummary}
              tasks={loose()}
              open={() => props.open(UNGROUPED_REF)}
              legacy
            />
          </Show>
        </div>
      </section>
    </main>
  );
}

function GroupCard(props: { group: TaskGroupSummary; tasks: Task[]; open: () => void; legacy?: boolean }) {
  const progress = () => props.group.taskCount ? Math.round(((props.group.taskCount - props.group.openCount) / props.group.taskCount) * 100) : 0;
  return (
    <button class="group-card group text-left" onClick={props.open}>
      <span class="group-stripe" style={{ background: props.group.color }} />
      <div class="group-identity">
        <span class="group-ref">{props.legacy ? 'Legacy work' : props.group.ref}</span>
        <h3>{props.group.name}</h3>
        <p>{props.group.description || 'Add a description to define the outcome for this group.'}</p>
      </div>
      <div class="task-preview">
        <For each={props.tasks.slice(0, 3)} fallback={<p class="empty-copy">No tasks yet. Open the group to add the first one.</p>}>
          {task => <div class="task-preview-row"><span class={`status-dot ${statusStyles[task.status]}`} /><span>{task.title}</span></div>}
        </For>
        <Show when={props.tasks.length > 3}><p class="more-count">{props.tasks.length - 3} more tasks</p></Show>
      </div>
      <div class="group-progress">
        <div class="progress-copy"><strong>{props.group.openCount}</strong><span> / {props.group.taskCount}</span></div>
        <div class="progress-track"><span style={{ width: `${progress()}%`, background: props.group.color }} /></div>
        <small>{progress()}% closed</small>
      </div>
      <span class="open-cue" aria-hidden="true">
        <svg viewBox="0 0 24 24"><path d="m9 5 7 7-7 7" /></svg>
      </span>
    </button>
  );
}

function GroupWorkspace(props: {
  groupRef: string;
  snapshot: WorkspaceSnapshot;
  back: () => void;
  openTask: (ref: string) => void;
  changed: () => void;
}) {
  const legacy = () => props.groupRef === UNGROUPED_REF;
  const group = createMemo(async (): Promise<TaskGroupDetail | null> => legacy() ? null : api.getGroup(props.groupRef));
  const [agentOpen, setAgentOpen] = createSignal(false);
  const [investigationRunOpen, setInvestigationRunOpen] = createSignal(false);
  const [error, setError] = createSignal('');
  const [busy, setBusy] = createSignal('');
  const [selectedTab, setSelectedTab] = createSignal<'overview' | 'investigation' | 'branch' | null>(null);

  const loose = () => props.snapshot.tasks.filter(task => !task.groupRef);
  const mutate = async (label: string, action: () => Promise<unknown>) => {
    setBusy(label); setError('');
    try { await action(); refresh(group); props.changed(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setBusy(''); }
  };

  return (
    <main class="workspace-page min-h-screen text-slate-950">
      <Loading fallback={<PageSkeleton />}>
        <Show when={legacy()} fallback={<GroupContent />}>
          <LegacyGroup tasks={loose()} back={props.back} openTask={props.openTask} />
        </Show>
      </Loading>
    </main>
  );

  function GroupContent() {
    return (
      <Show when={group()} keyed>{detail => {
        const investigation = () => props.snapshot.investigations.find(item => item.ref === detail.investigationRef);
        const branch = () => props.snapshot.branches.find(item => item.branchName === detail.branchName);
        const tab = () => selectedTab() ?? (detail.tasks.length ? 'overview' : 'investigation');
        const setTab = (value: 'overview' | 'investigation' | 'branch') => setSelectedTab(value);
        return <>
        <header class="workspace-header">
          <div class="workspace-topbar"><Brand compact /><span class="topbar-divider" /><span>{detail.name}</span></div>
          <div class="mx-auto max-w-[1600px] px-5 pb-0 pt-5 sm:px-8">
            <button class="back-link" onClick={props.back}><BackIcon />All groups</button>
            <div class="mt-5 flex flex-wrap items-end justify-between gap-5">
              <div>
                <div class="group-context"><span style={{ background: detail.color }} /><span>{detail.ref}</span></div>
                <h1 class="workspace-title">{detail.name}</h1>
                <p class="workspace-description">{detail.description || 'Add a description to define the outcome for this group.'}</p>
              </div>
              <Show when={detail.tasks.length > 0} fallback={<button class="button-primary" onClick={() => investigation() ? setInvestigationRunOpen(true) : setTab('investigation')}>{investigation()?.status === 'complete' ? 'Run investigation again' : 'Run investigation'}</button>}>
                <button class="button-primary" disabled={!detail.queue.length || groupRunActive(detail.run)} onClick={() => setAgentOpen(true)}>
                  {groupRunActive(detail.run) ? 'Group is running…' : 'Work with an agent'}
                </button>
              </Show>
            </div>
            <nav class="workspace-tabs">
              <Tab active={tab() === 'overview'} onClick={() => setTab('overview')}>Tasks</Tab>
              <Tab active={tab() === 'investigation'} onClick={() => setTab('investigation')}>Investigation</Tab>
              <Tab active={tab() === 'branch'} onClick={() => setTab('branch')}>Branch</Tab>
            </nav>
          </div>
        </header>
        <div class="mx-auto max-w-[1600px] px-5 py-8 sm:px-8">
          <Show when={error()}><p class="banner mb-5">{error()}</p></Show>
          <Show when={tab() === 'overview'}><GroupOverview group={detail} openTask={props.openTask} busy={busy()} mutate={mutate} /></Show>
          <Show when={tab() === 'investigation'}><InvestigationPanel investigation={investigation()} group={detail} changed={() => { props.changed(); refresh(group); }} /></Show>
          <Show when={tab() === 'branch'}><BranchPanel group={detail} branch={branch()} busy={busy()} mutate={mutate} /></Show>
        </div>
        <Show when={agentOpen()}><AgentLauncher group={detail} close={() => setAgentOpen(false)} finished={() => { refresh(group); props.changed(); }} /></Show>
        <Show when={investigationRunOpen()}><Show when={investigation()} keyed>{item => <InvestigationLauncher investigation={item} close={() => setInvestigationRunOpen(false)} started={() => { refresh(group); props.changed(); }} />}</Show></Show>
      </>;
      }}</Show>
    );
  }
}

function Tab(props: { active: boolean; onClick: () => void; children: Element }) {
  return <button class={`workspace-tab ${props.active ? 'workspace-tab-active' : ''}`} onClick={props.onClick}>{props.children}</button>;
}

function GroupOverview(props: { group: TaskGroupDetail; openTask: (ref: string) => void; busy: string; mutate: (label: string, action: () => Promise<unknown>) => Promise<void> }) {
  const ready = () => props.group.tasks.filter(task => task.status === 'dev_complete').length;
  const closeable = () => props.group.tasks.filter(task => task.status === 'dev_complete' || task.status === 'verified').length;
  return (
    <div class="grid gap-6 lg:grid-cols-[1fr_320px]">
      <section>
        <div class="mb-4 flex items-center justify-between"><h2 class="section-title">Tasks</h2><span class="text-sm text-slate-500">{props.group.openCount} open · {props.group.taskCount} total</span></div>
        <div class="task-list">
          <For each={props.group.tasks} fallback={<p class="p-10 text-center text-sm text-slate-400">This group has no tasks yet.</p>}>
            {(task, index) => <TaskRow task={task} index={index()} onClick={() => props.openTask(task.ref)} />}
          </For>
        </div>
        <Show when={props.group.outsideBlockers.length}><p class="mt-4 rounded-xl bg-amber-50 p-4 text-sm text-amber-800">This group is waiting on {props.group.outsideBlockers.map(task => task.ref).join(', ')} from outside the group.</p></Show>
      </section>
      <aside class="space-y-5">
        <InfoCard title="Next up">
          <Show when={nextWorkableTask(props.group)} fallback={<p class="text-sm text-slate-500">Nothing is currently ready to start.</p>}>
            {task => <button class="w-full text-left" onClick={() => props.openTask(task().ref)}><span class="font-mono text-xs text-slate-400">{task().ref}</span><strong class="mt-1 block text-sm">{task().title}</strong></button>}
          </Show>
        </InfoCard>
        <Show when={props.group.run}>
          {run => <InfoCard title="Latest group run"><div class="flex items-center justify-between"><span class="text-sm font-medium">{GROUP_RUN_STATUS_LABELS[run().status]}</span><span class="text-xs text-slate-400">{run().worked.length} finished</span></div><Show when={run().stopReason}><p class="mt-2 text-xs leading-5 text-slate-500">{run().stopReason}</p></Show></InfoCard>}
        </Show>
        <InfoCard title="Sign off">
          <p class="mb-3 text-xs leading-5 text-slate-500">Apply review decisions to every eligible task in this group.</p>
          <div class="grid gap-2">
            <button class="button" disabled={!ready() || !!props.busy} onClick={() => props.mutate('verify', () => api.advanceGroup(props.group.ref, 'verified'))}>Verify all ({ready()})</button>
            <button class="button-primary" disabled={!closeable() || !!props.busy} onClick={() => confirm('Verify and close every eligible task in this group?') && props.mutate('close', () => api.advanceGroup(props.group.ref, 'closed'))}>Verify and close ({closeable()})</button>
          </div>
        </InfoCard>
      </aside>
    </div>
  );
}

function TaskRow(props: { task: Task; index: number; onClick: () => void }) {
  return (
    <button class="task-row flex w-full items-start gap-4 px-5 py-4 text-left" onClick={props.onClick}>
      <span class="mt-1 w-5 text-right font-mono text-xs text-slate-300">{props.index + 1}</span>
      <div class="min-w-0 flex-1"><div class="flex flex-wrap items-center gap-2"><span class="font-mono text-xs font-semibold text-slate-400">{props.task.ref}</span><StatusBadge status={props.task.status} /></div><p class="mt-1.5 truncate text-sm font-medium text-slate-800">{props.task.title}</p></div>
      <span class="mt-2 text-xs capitalize text-slate-400">{props.task.priority}</span>
    </button>
  );
}

function InfoCard(props: { title: string; children: Element }) {
  return <section class="info-panel"><h3>{props.title}</h3>{props.children}</section>;
}

function InvestigationPanel(props: { investigation?: Investigation; group: TaskGroupDetail; changed: () => void }) {
  const detail = createMemo(async (): Promise<InvestigationDetail | null> => props.investigation ? api.getInvestigation(props.investigation.ref) : null);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  const [launcherOpen, setLauncherOpen] = createSignal(false);
  const attach = async () => {
    setBusy(true); setError('');
    try { await api.ensureGroupInvestigation(props.group.ref, props.group.description); props.changed(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setBusy(false); }
  };
  return (
    <section class="mx-auto max-w-4xl">
      <div class="investigation-heading"><div><h2>Investigation</h2><p>The brief is the question an agent will research before it creates work.</p></div></div>
      <Show when={props.investigation} fallback={<div class="investigation-setup"><h3>Add an investigation to this group</h3><p>This is an older group. Its current description can become the investigation brief, without moving or changing any existing tasks.</p><button class="button-primary" disabled={busy()} onClick={attach}>{busy() ? 'Setting up…' : 'Use description as investigation'}</button><Show when={error()}><p class="banner mt-4">{error()}</p></Show></div>}>
        <Loading fallback={<PageSkeleton compact />}>
          <Show when={detail()} keyed>{investigation => <>
            <div class="investigation-flow"><div class="flow-step flow-step-current"><span>1</span><strong>Brief</strong><small>Define the question</small></div><div class={`flow-step ${investigation.status !== 'draft' ? 'flow-step-current' : ''}`}><span>2</span><strong>Investigate</strong><small>Agent researches</small></div><div class={`flow-step ${investigation.status === 'complete' ? 'flow-step-current' : ''}`}><span>3</span><strong>Tasks</strong><small>Work lands here</small></div></div>
            <div class="investigation-panel">
              <header><div><span>{investigation.ref}</span><h3>{props.group.name}</h3></div><span class="investigation-status">{INVESTIGATION_STATUS_LABELS[investigation.status]}</span></header>
              <InvestigationBrief investigation={investigation} saved={() => { refresh(detail); props.changed(); }} />
              <div class="investigation-actions"><div><strong>{investigation.status === 'complete' ? 'Investigation complete' : 'Ready to investigate?'}</strong><p>{investigation.status === 'complete' ? `${investigation.tasks.length} task(s) were created from this investigation.` : 'The agent will only research and plan. Product code is changed later by task agents.'}</p></div><button class="button-primary" disabled={!investigation.brief.trim() || investigation.status === 'investigating'} onClick={() => setLauncherOpen(true)}>{investigation.status === 'complete' ? 'Run again' : investigation.status === 'investigating' ? 'Investigation running…' : 'Run investigation'}</button></div>
              <Show when={investigation.findings}><div class="investigation-findings"><h4>Findings</h4><p>{investigation.findings}</p></div></Show>
            </div>
            <Show when={launcherOpen()}><InvestigationLauncher investigation={investigation} close={() => setLauncherOpen(false)} started={() => { refresh(detail); props.changed(); }} /></Show>
          </>}</Show>
        </Loading>
      </Show>
    </section>
  );
}

function InvestigationBrief(props: { investigation: InvestigationDetail; saved: () => void }) {
  const [brief, setBrief] = createSignal(props.investigation.brief);
  const [busy, setBusy] = createSignal(false);
  const [saved, setSaved] = createSignal(false);
  const [error, setError] = createSignal('');
  const save = async () => { setBusy(true); setSaved(false); setError(''); try { await api.updateInvestigation(props.investigation.ref, { brief: brief() }); props.saved(); setSaved(true); } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); } finally { setBusy(false); } };
  return <div class="investigation-brief"><label class="field"><span>Investigation brief</span><textarea value={brief()} onInput={event => { setBrief(event.currentTarget.value); setSaved(false); }} placeholder="Describe what the agent should investigate, where to start, and what a useful answer should cover." /></label><Show when={error()}><p class="banner mt-4">{error()}</p></Show><div><span>{saved() ? 'Saved' : `${brief().length} characters`}</span><button class="button" disabled={busy() || brief() === props.investigation.brief} onClick={save}>{busy() ? 'Saving…' : 'Save brief'}</button></div></div>;
}

function BranchPanel(props: { group: TaskGroupDetail; branch?: CombinedBranchDetail; busy: string; mutate: (label: string, action: () => Promise<unknown>) => Promise<void> }) {
  return (
    <section class="mx-auto max-w-4xl">
      <h2 class="section-title mb-4">Delivery branch</h2>
      <div class="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
        <div class="flex flex-wrap items-start justify-between gap-4"><div><code class="text-sm font-semibold">{props.group.branchName}</code><p class="mt-1 text-xs text-slate-500">from {props.group.baseBranch}</p></div><span class={`rounded-full px-3 py-1 text-xs font-medium ${props.group.git.exists ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>{props.group.git.exists ? 'Local branch ready' : 'Not created yet'}</span></div>
        <div class="mt-6 grid gap-3 sm:grid-cols-3"><Metric label="Commits" value={props.group.git.commits.length} /><Metric label="Files changed" value={props.group.git.filesChanged} /><Metric label="Ahead of base" value={props.group.git.aheadOfBase ?? '—'} /></div>
        <Show when={props.group.git.commits.length}><ul class="mt-6 divide-y divide-slate-100 rounded-xl border border-slate-200"><For each={props.group.git.commits}>{commit => <li class="flex gap-3 px-4 py-3 text-sm"><code class="text-slate-400">{commit.shortSha}</code><span>{commit.subject}</span></li>}</For></ul></Show>
        <Show when={props.branch} fallback={<p class="mt-5 text-sm text-slate-500">Branch delivery controls appear after completed work is merged into the group branch.</p>}>
          {branch => <div class="mt-6 flex flex-wrap gap-2"><button class="button" disabled={!!props.busy} onClick={() => props.mutate('describe', () => api.describeBranch(branch().branchName))}>Generate description</button><button class="button" disabled={!!props.busy} onClick={() => props.mutate('checks', () => api.runChecks(branch().branchName))}>Run checks</button><button class="button-primary" disabled={!!props.busy || !!branch().prUrl} onClick={() => props.mutate('pr', () => api.createPr(branch().branchName, true))}>{branch().prUrl ? 'Pull request opened' : 'Open draft PR'}</button><Show when={branch().prUrl}><a class="button" href={branch().prUrl!} target="_blank" rel="noreferrer">View PR</a></Show></div>}
        </Show>
      </div>
    </section>
  );
}

function Metric(props: { label: string; value: string | number }) {
  return <div class="rounded-xl bg-slate-50 p-4"><strong class="block text-xl">{props.value}</strong><span class="text-xs text-slate-500">{props.label}</span></div>;
}

function LegacyGroup(props: { tasks: Task[]; back: () => void; openTask: (ref: string) => void }) {
  return <div class="mx-auto max-w-5xl px-5 py-8 sm:px-8"><button class="mb-5 text-sm font-medium text-slate-500" onClick={props.back}>← All groups</button><div class="rounded-2xl border border-amber-200 bg-amber-50 p-5"><h1 class="text-2xl font-semibold">Ungrouped</h1><p class="mt-2 text-sm text-amber-800">These are legacy records. They remain available, but new tasks cannot be added here. Move each task into a real group when convenient.</p></div><div class="mt-6 overflow-hidden rounded-2xl bg-white ring-1 ring-slate-200"><For each={props.tasks}>{(task, index) => <TaskRow task={task} index={index()} onClick={() => props.openTask(task.ref)} />}</For></div></div>;
}

type ComparisonMode = 'side-by-side' | 'slider' | 'diff' | 'before' | 'after';

function ComparisonViewer(props: { comparison: VisualComparison }) {
  const before = () => imageUrl(props.comparison.beforePath);
  const after = () => imageUrl(props.comparison.afterPath);
  const diff = () => imageUrl(props.comparison.diffPath);
  const initial: ComparisonMode = diff() ? 'diff' : before() && after() ? 'side-by-side' : after() ? 'after' : 'before';
  const [mode, setMode] = createSignal<ComparisonMode>(initial);
  const [position, setPosition] = createSignal(50);
  const modes = (): { id: ComparisonMode; label: string; enabled: boolean }[] => [
    { id: 'side-by-side', label: 'Side by side', enabled: Boolean(before() && after()) },
    { id: 'slider', label: 'Slider', enabled: Boolean(before() && after()) },
    { id: 'diff', label: 'Diff', enabled: Boolean(diff()) },
    { id: 'before', label: 'Before', enabled: Boolean(before()) },
    { id: 'after', label: 'After', enabled: Boolean(after()) },
  ];
  const singleImage = () => mode() === 'diff' ? diff() : mode() === 'before' ? before() : after();

  return (
    <article class="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-slate-200">
      <header class="flex flex-wrap items-center gap-3 border-b border-slate-200 px-5 py-4">
        <strong class="font-mono text-sm">{props.comparison.scenario}</strong>
        <span class="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold capitalize text-slate-600">{props.comparison.status}</span>
        <Show when={props.comparison.percentChanged !== null}><span class="text-xs text-slate-400">{props.comparison.percentChanged!.toFixed(2)}% of pixels</span></Show>
        <div class="ml-auto flex flex-wrap gap-1">
          <For each={modes()}>{option => <button class={option.id === mode() ? 'button-primary' : 'button'} disabled={!option.enabled} onClick={() => setMode(option.id)}>{option.label}</button>}</For>
        </div>
      </header>
      <Show when={props.comparison.description}><p class="px-5 pt-4 text-sm text-slate-500">{props.comparison.description}</p></Show>
      <div class="p-5">
        <Show when={mode() === 'side-by-side'}>
          <div class="grid gap-4 xl:grid-cols-2">
            <figure><figcaption class="mb-2 text-xs font-semibold text-slate-400">Before</figcaption><img class="w-full rounded-xl ring-1 ring-slate-200" src={before()!} alt={`${props.comparison.scenario} before`} /></figure>
            <figure><figcaption class="mb-2 text-xs font-semibold text-slate-400">After</figcaption><img class="w-full rounded-xl ring-1 ring-slate-200" src={after()!} alt={`${props.comparison.scenario} after`} /></figure>
          </div>
        </Show>
        <Show when={mode() === 'slider'}>
          <div>
            <div class="relative overflow-hidden rounded-xl ring-1 ring-slate-200">
              <img class="block w-full" src={before()!} alt={`${props.comparison.scenario} before`} />
              <img class="absolute inset-0 block h-full w-full" style={{ 'clip-path': `inset(0 ${100 - position()}% 0 0)` }} src={after()!} alt={`${props.comparison.scenario} after`} />
              <div class="pointer-events-none absolute inset-y-0 w-0.5 bg-white shadow" style={{ left: `${position()}%` }}><span class="absolute left-1/2 top-1/2 h-9 w-9 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-blue-600 shadow-lg" /></div>
            </div>
            <input class="mt-4 w-full accent-blue-500" type="range" min="0" max="100" value={position()} onInput={event => setPosition(Number(event.currentTarget.value))} aria-label="Reveal the after image" />
            <p class="mt-1 text-center text-xs text-slate-400">Left of the handle is after; right is before.</p>
          </div>
        </Show>
        <Show when={mode() !== 'side-by-side' && mode() !== 'slider'}>
          <Show when={singleImage()} fallback={<div class="empty-panel">This image was not captured.</div>}>{src => <img class="block w-full rounded-xl ring-1 ring-slate-200" src={src()} alt={`${props.comparison.scenario} ${mode()}`} />}</Show>
        </Show>
      </div>
    </article>
  );
}

function TaskWorkspace(props: {
  groupRef: string;
  taskRef: string;
  snapshot: WorkspaceSnapshot;
  back: () => void;
  openTask: (ref: string) => void;
  changed: () => void;
}) {
  const task = createMemo(() => api.getTask(props.taskRef));
  const group = createMemo(async () => props.groupRef === UNGROUPED_REF ? null : api.getGroup(props.groupRef));
  const [editing, setEditing] = createSignal(false);
  const [agentOpen, setAgentOpen] = createSignal(false);
  const [busy, setBusy] = createSignal('');
  const [error, setError] = createSignal('');
  const [note, setNote] = createSignal('');

  const mutate = async (label: string, action: () => Promise<unknown>) => {
    setBusy(label); setError('');
    try { await action(); refresh(task); refresh(group); props.changed(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setBusy(''); }
  };

  return (
    <main class="task-workspace min-h-screen">
      <Loading fallback={<PageSkeleton />}>
        <div class="mx-auto grid min-h-screen w-full max-w-[1720px] lg:grid-cols-[310px_1fr] xl:grid-cols-[340px_1fr]">
          <aside class="task-sidebar">
            <Brand />
            <button class="back-link mt-8" onClick={props.back}><BackIcon />Back to group</button>
            <div class="sidebar-heading"><h2>Tasks in this group</h2><span>{group()?.tasks.length ?? props.snapshot.tasks.filter(item => !item.groupRef).length}</span></div>
            <div class="task-navigation">
              <For each={group()?.tasks ?? props.snapshot.tasks.filter(item => !item.groupRef)}>
                {item => <button class={`task-nav-item ${item.ref === props.taskRef ? 'task-nav-active' : ''}`} onClick={() => props.openTask(item.ref)}><span>{item.ref}</span><strong>{item.title}</strong></button>}
              </For>
            </div>
          </aside>
          <TaskDetailPanel task={task()} group={group()} groups={props.snapshot.groups} busy={busy()} error={error()} editing={editing()} setEditing={setEditing} note={note()} setNote={setNote} mutate={mutate} openAgent={() => setAgentOpen(true)} />
        </div>
        <Show when={agentOpen()}><Show when={group()}>{detail => <AgentLauncher group={detail()} task={task()} close={() => setAgentOpen(false)} finished={() => { refresh(task); refresh(group); props.changed(); }} />}</Show></Show>
      </Loading>
    </main>
  );
}

function TaskDetailPanel(props: {
  task: TaskDetail;
  group: TaskGroupDetail | null;
  groups: TaskGroupSummary[];
  busy: string;
  error: string;
  editing: boolean;
  setEditing: (value: boolean) => void;
  note: string;
  setNote: (value: string) => void;
  mutate: (label: string, action: () => Promise<unknown>) => Promise<void>;
  openAgent: () => void;
}) {
  let title!: HTMLInputElement;
  let description!: HTMLTextAreaElement;
  let priority!: HTMLSelectElement;
  return (
    <article class="task-detail p-5 sm:p-8 lg:p-10">
      <Show when={props.error}><p class="banner mb-5">{props.error}</p></Show>
      <div class="task-titlebar flex flex-wrap items-start justify-between gap-4">
        <div><div class="flex items-center gap-2"><span class="task-ref">{props.task.ref}</span><StatusBadge status={props.task.status} /></div><h1>{props.task.title}</h1></div>
        <div class="flex gap-2"><Show when={props.group}><button class="button-primary" onClick={props.openAgent}>Work with agent</button></Show><button class="button" onClick={() => props.setEditing(!props.editing)}>{props.editing ? 'Cancel' : 'Edit'}</button></div>
      </div>
      <Show when={props.editing} fallback={<p class="task-description whitespace-pre-wrap">{props.task.description || 'Add a description so the expected change is unambiguous.'}</p>}>
        <div class="mt-6 rounded-2xl bg-white p-5 ring-1 ring-slate-200"><label class="field"><span>Title</span><input ref={title} value={props.task.title} /></label><label class="field mt-4"><span>Description</span><textarea ref={description} value={props.task.description} /></label><div class="mt-4 grid gap-4 sm:grid-cols-2"><label class="field"><span>Priority</span><select ref={priority} value={props.task.priority}><option>low</option><option>medium</option><option>high</option></select></label><label class="field"><span>Group</span><select value={props.task.groupRef ?? ''} onChange={event => props.mutate('group', () => api.setTaskGroup(props.task.ref, event.currentTarget.value))} disabled={!props.task.groupRef}><For each={props.groups}>{group => <option value={group.ref}>{group.name}</option>}</For></select></label></div><button class="button-primary mt-4" onClick={() => props.mutate('save', () => api.updateTask(props.task.ref, { title: title.value, description: description.value, priority: priority.value as Priority })).then(() => props.setEditing(false))}>Save changes</button></div>
      </Show>

      <section class="mt-8"><h2 class="section-title mb-4">Workflow</h2><div class="flex flex-wrap gap-2"><For each={STATUSES}>{status => <button class={status === props.task.status ? 'button-primary' : 'button'} disabled={!!props.busy || status === props.task.status || status === 'closed'} onClick={() => props.mutate(status, () => api.setStatus(props.task.ref, status))}>{STATUS_LABELS[status]}</button>}</For><Show when={props.task.status === 'verified'}><button class="button-primary" onClick={() => props.mutate('close', () => api.closeTask(props.task.ref))}>Close task</button></Show></div></section>

      <div class="mt-8 grid gap-6 xl:grid-cols-2">
        <InfoCard title="Details"><dl class="space-y-3 text-sm"><Detail label="Priority" value={props.task.priority} /><Detail label="Branch" value={props.task.branchName ?? '—'} /><Detail label="Estimate" value={`${props.task.estimateUnits} unit(s)`} /><Detail label="Investigation" value={props.task.investigationRef ?? '—'} /><Detail label="Tags" value={props.task.tags.join(', ') || '—'} /></dl></InfoCard>
        <InfoCard title="Dependencies"><Show when={props.task.dependsOn.length} fallback={<p class="text-sm text-slate-500">No blockers.</p>}><div class="flex flex-wrap gap-2"><For each={props.task.dependsOn}>{ref => <span class="rounded-lg bg-slate-100 px-2 py-1 font-mono text-xs">{ref}</span>}</For></div></Show><Show when={props.task.blocks.length}><p class="mt-4 text-xs text-slate-500">Blocks {props.task.blocks.join(', ')}</p></Show></InfoCard>
      </div>

      <section class="mt-8">
        <div class="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div><h2 class="section-title">Visual checkpoints</h2><p class="mt-1 text-xs text-slate-500">The latest capture is shown at the full detail-column width.</p></div>
          <div class="flex gap-2"><button class="button" disabled={!!props.busy} onClick={() => props.mutate('before', () => api.capture(props.task.ref, 'before'))}>Capture before</button><button class="button" disabled={!!props.busy} onClick={() => props.mutate('after', () => api.capture(props.task.ref, 'after'))}>Capture after</button></div>
        </div>
        <Show when={props.task.runs.at(-1)} fallback={<div class="empty-panel">No visual runs yet.</div>}>
          {run => <div class="space-y-5"><div class="flex justify-between text-xs text-slate-400"><span class="capitalize">Latest {run().phase} capture</span><time>{run().createdAt.slice(0, 16).replace('T', ' ')}</time></div><For each={run().comparisons}>{comparison => <ComparisonViewer comparison={comparison} />}</For></div>}
        </Show>
      </section>

      <section class="mt-8"><h2 class="section-title mb-4">Attachments</h2><div class="flex flex-wrap gap-2"><For each={props.task.attachments} fallback={<span class="text-sm text-slate-500">No attachments.</span>}>{attachment => <a class="button" href={taskAssetUrl(props.task.ref, attachment.name)} target="_blank">{attachment.name}</a>}</For></div></section>

      <section class="mt-8"><h2 class="section-title mb-4">Notes and history</h2><div class="rounded-2xl bg-white p-5 ring-1 ring-slate-200"><div class="flex gap-2"><input class="input flex-1" value={props.note} onInput={event => props.setNote(event.currentTarget.value)} placeholder="Add a note…" /><button class="button-primary" disabled={!props.note.trim()} onClick={() => props.mutate('note', () => api.addNote(props.task.ref, props.note)).then(() => props.setNote(''))}>Add note</button></div><ol class="mt-5 space-y-4"><For each={[...props.task.events].reverse()}>{event => <li class="border-l-2 border-slate-200 pl-4"><div class="flex gap-2 text-xs text-slate-400"><span class="capitalize">{event.type.replaceAll('_', ' ')}</span><time>{event.createdAt.slice(0, 16).replace('T', ' ')}</time></div><Show when={event.note}><p class="mt-1 text-sm text-slate-600">{event.note}</p></Show></li>}</For></ol></div></section>
    </article>
  );
}

function Detail(props: { label: string; value: string }) {
  return <div class="flex justify-between gap-4"><dt class="text-slate-400">{props.label}</dt><dd class="break-all text-right font-medium capitalize">{props.value}</dd></div>;
}

function PageSkeleton(props: { compact?: boolean }) {
  return <div class={`mx-auto max-w-[1600px] animate-pulse px-6 ${props.compact ? 'py-6' : 'py-16'}`}><div class="h-7 w-48 rounded bg-slate-200" /><div class="mt-5 h-32 rounded-2xl bg-white ring-1 ring-slate-200" /></div>;
}

function NotesWorkspace(props: { select: (view: MainView) => void }) {
  const [query, setQuery] = createSignal('');
  const [folder, setFolder] = createSignal('');
  const [tag, setTag] = createSignal('');
  const [selectedPath, setSelectedPath] = createSignal('');
  const [noteMode, setNoteMode] = createSignal<'write' | 'preview'>('preview');
  const [creating, setCreating] = createSignal(false);
  const [newTitle, setNewTitle] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  const listing = createMemo(() => api.listNotes({ q: query() || undefined, folder: folder() || undefined, tag: tag() || undefined }));
  const selected = createMemo(async (): Promise<Note | null> => selectedPath() ? api.getNote(selectedPath()) : null);

  const choose = (path: string) => { setSelectedPath(path); setNoteMode('preview'); refresh(selected); };
  const create = async () => {
    if (!newTitle().trim()) return;
    setBusy(true); setError('');
    try { const note = await api.createNote({ title: newTitle().trim(), folder: folder() || undefined }); setCreating(false); setNewTitle(''); refresh(listing); choose(note.path); }
    catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setBusy(false); }
  };
  const initialise = async () => {
    setBusy(true); setError('');
    try { await api.initNotes(); refresh(listing); }
    catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setBusy(false); }
  };
  const sync = async () => {
    setBusy(true); setError('');
    try {
      await api.pullNotes();
      refresh(listing);
      refresh(selected);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };
  const push = async () => {
    setBusy(true); setError('');
    try {
      await api.syncNotes(true);
      refresh(listing);
      refresh(selected);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  return <main class="app-shell min-h-screen text-slate-950"><ProductRail active="notes" select={props.select} />
    <Loading fallback={<PageSkeleton />}><Show when={listing()} keyed>{data => <section class="library-surface">
      <header class="library-header"><div><p class="eyebrow">Reference workspace</p><h1>Notes</h1><p>Keep research, decisions and evidence in a versioned folder beside the work.</p></div><div class="library-header-actions"><Show when={data.workspace.exists && data.workspace.git.repo}><button class="button" disabled={busy()} onClick={sync}>{busy() ? 'Syncing…' : 'Sync'}</button><button class="button" disabled={busy() || !data.workspace.git.upstream} title={data.workspace.git.upstream ?? 'No upstream configured for this repository.'} onClick={push}>{busy() ? 'Pushing…' : 'Push'}</button></Show><button class="button-primary" disabled={!data.workspace.exists || busy()} onClick={() => setCreating(true)}><PlusIcon />New note</button></div></header>
      <Show when={error()}><p class="banner mb-5">{error()}</p></Show>
      <div class="library-layout">
        <aside class="library-list"><label class="library-search"><span>Find a note</span><input value={query()} onInput={event => setQuery(event.currentTarget.value)} placeholder="Search notes" type="search" /></label>
          <Show when={data.folders.length > 0 || data.tags.length > 0}><div class="library-filters"><Show when={data.folders.length > 0}><select value={folder()} onChange={event => setFolder(event.currentTarget.value)}><option value="">All folders</option><For each={data.folders}>{item => <option value={item}>{item}</option>}</For></select></Show><Show when={data.tags.length > 0}><select value={tag()} onChange={event => setTag(event.currentTarget.value)}><option value="">All tags</option><For each={data.tags}>{item => <option value={item}>#{item}</option>}</For></select></Show></div></Show>
          <div class="note-list"><For each={data.notes} fallback={<p class="empty-copy p-4">{data.workspace.exists ? 'No notes match these filters.' : 'The notes folder has not been created yet.'}</p>}>{item => <button class={`note-list-item ${selectedPath() === item.path ? 'note-list-active' : ''}`} onClick={() => choose(item.path)}><span>{item.folder ? `${item.folder}/` : 'Note'}</span><strong>{item.title}</strong><p>{item.excerpt || 'No preview yet.'}</p><small>{item.tags.map(value => `#${value}`).join(' ')}</small></button>}</For></div>
          <NotesStatus workspace={data.workspace} busy={busy()} initialise={initialise} />
        </aside>
        <section class="note-detail-pane"><Show when={creating()} fallback={<Loading fallback={<PageSkeleton compact />}><Show when={selected()} keyed fallback={<div class="library-empty"><h2>Choose a note</h2><p>Select a note to read or edit it. Notes remain ordinary Markdown files in the shared folder.</p></div>}>{note => <NoteEditor note={note} mode={noteMode()} setMode={setNoteMode} saved={async () => { await refresh(selected); await refresh(listing); }} close={() => setSelectedPath('')} />}</Show></Loading>}><div class="editor-panel"><h2>New note</h2><label class="field"><span>Title</span><input autofocus value={newTitle()} onInput={event => setNewTitle(event.currentTarget.value)} /></label><div class="mt-5 flex gap-2"><button class="button" onClick={() => setCreating(false)}>Cancel</button><button class="button-primary" disabled={!newTitle().trim() || busy()} onClick={create}>Create note</button></div></div></Show>
        </section>
      </div>
    </section>}</Show></Loading>
  </main>;
}

function NotesStatus(props: { workspace: NotesWorkspaceInfo; busy: boolean; initialise: () => Promise<void> }) {
  return <div class="notes-status"><p>{props.workspace.dir}</p><Show when={!props.workspace.exists} fallback={<><p>{props.workspace.git.repo ? `${props.workspace.git.branch ?? 'Detached'} · ${props.workspace.git.dirty ? `${props.workspace.git.dirty} uncommitted` : 'clean'}` : 'Not yet a Git repository'}</p></>}><p>The notes folder does not exist yet.</p><button class="button-primary" disabled={props.busy} onClick={props.initialise}>Create folder</button></Show></div>;
}

function NoteEditor(props: { note: Note; mode: 'write' | 'preview'; setMode: (mode: 'write' | 'preview') => void; saved: () => Promise<unknown>; close: () => void }) {
  const [title, setTitle] = createSignal(props.note.title);
  const [tags, setTags] = createSignal(props.note.tags.join(', '));
  const [body, setBody] = createSignal(props.note.body);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  let editor: HTMLTextAreaElement | undefined;
  const noteInput = () => ({ title: title().trim(), body: body(), tags: tags().split(',').map(value => value.trim()).filter(Boolean) });
  const preview = () => renderMarkdown(body(), { resolveLink: href => noteAssetUrl(props.note.path, href) });
  const applySavedNote = (note: Note) => {
    setTitle(note.title);
    setTags(note.tags.join(', '));
    setBody(note.body);
  };
  const save = async () => {
    setBusy(true); setError('');
    try {
      applySavedNote(await api.updateNote(props.note.path, noteInput()));
      await props.saved();
    }
    catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setBusy(false); }
  };
  const remove = async () => {
    if (!confirm(`Delete ${title()}?`)) return;
    setBusy(true);
    try { await api.deleteNote(props.note.path); props.close(); await props.saved(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setBusy(false); }
  };

  const insertAtCursor = (markdown: string): string => {
    const start = editor?.selectionStart ?? body().length;
    const end = editor?.selectionEnd ?? start;
    const before = body().slice(0, start);
    const after = body().slice(end);
    const next = `${before}${before && !before.endsWith('\n') ? '\n\n' : ''}${markdown}\n${after}`;
    setBody(next);
    const caret = next.length - after.length;
    requestAnimationFrame(() => {
      editor?.focus();
      editor?.setSelectionRange(caret, caret);
    });
    return next;
  };

  const pasteImages = async (event: ClipboardEvent) => {
    const images = [...(event.clipboardData?.files ?? [])].filter(file => file.type.startsWith('image/'));
    if (!images.length) return;
    event.preventDefault();
    setBusy(true); setError('');
    try {
      // Attachments belong to a saved note. Save the current draft first so the
      // final update cannot replace text typed before the paste.
      await api.updateNote(props.note.path, noteInput());
      const uploaded = await api.uploadAttachments(props.note.path, images);
      const nextBody = insertAtCursor(uploaded.added.map(item => item.markdown).join('\n'));
      applySavedNote(await api.updateNote(props.note.path, { body: nextBody }));
      await props.saved();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  return <article class="note-editor">
    <header>
      <div><p class="note-path">{props.note.path}</p><h2>{title()}</h2></div>
      <div class="flex flex-wrap gap-2">
        <div class="note-modes" role="group" aria-label="Note view">
          <button class={props.mode === 'write' ? 'active' : ''} onClick={() => props.setMode('write')}>Write</button>
          <button class={props.mode === 'preview' ? 'active' : ''} onClick={() => props.setMode('preview')}>Preview</button>
        </div>
        <button class="button" disabled={busy()} onClick={remove}>Delete</button>
        <button class="button-primary" disabled={!title().trim() || busy()} onClick={save}>{busy() ? 'Saving…' : 'Save changes'}</button>
      </div>
    </header>
    <Show when={error()}><p class="banner mt-5">{error()}</p></Show>
    <Show when={props.mode === 'write'} fallback={<div class="note-rendered markdown" innerHTML={preview()} />}>
      <div class="editor-fields">
        <label class="field"><span>Title</span><input value={title()} onInput={event => setTitle(event.currentTarget.value)} /></label>
        <label class="field"><span>Tags</span><input value={tags()} onInput={event => setTags(event.currentTarget.value)} placeholder="research, decision" /></label>
        <label class="field"><span>Markdown — paste an image to attach and insert it here</span><textarea ref={editor} class="note-body" value={body()} onInput={event => setBody(event.currentTarget.value)} onPaste={pasteImages} /></label>
      </div>
    </Show>
  </article>;
}

function IssuesWorkspace(props: { select: (view: MainView) => void }) {
  const [query, setQuery] = createSignal(''); const [state, setState] = createSignal<IssueState | 'all'>('all'); const [source, setSource] = createSignal(''); const [label, setLabel] = createSignal(''); const [selectedId, setSelectedId] = createSignal('');
  const [busy, setBusy] = createSignal(false); const [error, setError] = createSignal('');
  const listing = createMemo(() => api.listIssues({ q: query() || undefined, state: state(), source: source() || undefined, label: label() || undefined }));
  const selected = createMemo(async (): Promise<IssueDetail | null> => selectedId() ? api.getIssue(selectedId()) : null);
  const choose = (id: string) => { setSelectedId(id); refresh(selected); };
  const sync = async () => {
    setBusy(true); setError('');
    try {
      await api.pullNotes();
      refresh(listing);
      refresh(selected);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };
  const push = async () => {
    setBusy(true); setError('');
    try {
      await api.syncNotes(true);
      refresh(listing);
      refresh(selected);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };
  return <main class="app-shell min-h-screen text-slate-950"><ProductRail active="issues" select={props.select} />
    <Loading fallback={<PageSkeleton />}><Show when={listing()} keyed>{data => <section class="library-surface"><header class="library-header"><div><p class="eyebrow">Imported context</p><h1>Issues</h1><p>Review provider records from the notes folder. This view never writes back to the tracker.</p></div><div class="library-header-actions"><Show when={data.notes.exists && data.notes.git.repo}><button class="button" disabled={busy()} onClick={sync}>{busy() ? 'Syncing…' : 'Sync'}</button><button class="button" disabled={busy() || !data.notes.git.upstream} title={data.notes.git.upstream ?? 'No upstream configured for this repository.'} onClick={push}>{busy() ? 'Pushing…' : 'Push'}</button></Show></div></header><Show when={error()}><p class="banner mb-5">{error()}</p></Show><div class="library-layout">
      <aside class="library-list"><label class="library-search"><span>Find an issue</span><input value={query()} onInput={event => setQuery(event.currentTarget.value)} placeholder="Search issues" type="search" /></label><div class="library-filters"><select value={state()} onChange={event => setState(event.currentTarget.value as IssueState | 'all')}><option value="all">All states</option><option value="open">Open</option><option value="closed">Closed</option></select><Show when={data.facets.sources.length > 1}><select value={source()} onChange={event => setSource(event.currentTarget.value)}><option value="">All sources</option><For each={data.facets.sources}>{item => <option value={item.source}>{ISSUE_SOURCE_LABELS[item.source] ?? item.source} ({item.count})</option>}</For></select></Show><Show when={data.facets.labels.length}><select value={label()} onChange={event => setLabel(event.currentTarget.value)}><option value="">All labels</option><For each={data.facets.labels}>{item => <option value={item}>{item}</option>}</For></select></Show></div><p class="issue-total">{data.issues.length} of {data.facets.total} shown</p></aside>
      <section class="issue-board"><Loading fallback={<PageSkeleton compact />}><Show when={selected()} keyed fallback={<For each={data.issues} fallback={<div class="library-empty"><h2>No issues found</h2><p>Place provider JSON files in the notes folder to see them here.</p></div>}>{issue => <IssueCard issue={issue} open={() => choose(issue.id)} />}</For>}>{issue => <IssueDetailPane issue={issue} back={() => setSelectedId('')} />}</Show></Loading></section>
    </div></section>}</Show></Loading>
  </main>;
}

function IssueCard(props: { issue: IssueSummary; open: () => void }) { return <button class="issue-card" onClick={props.open}><div><span class="source-badge">{ISSUE_SOURCE_LABELS[props.issue.source] ?? props.issue.source}</span><span class="issue-key">{props.issue.key}</span><span class={`issue-state issue-${props.issue.state}`}>{props.issue.stateLabel}</span></div><h2>{props.issue.title}</h2><p>{props.issue.excerpt || props.issue.container || 'No summary provided.'}</p><footer>{props.issue.labels.slice(0, 3).map(label => <span>{label.name}</span>)}</footer></button>; }

function IssueDetailPane(props: { issue: IssueDetail; back: () => void }) { const [raw, setRaw] = createSignal(false); return <article class="issue-detail-pane"><button class="back-link" onClick={props.back}><BackIcon />All issues</button><header><div><span class="source-badge">{ISSUE_SOURCE_LABELS[props.issue.source] ?? props.issue.source}</span><span class="issue-key">{props.issue.key}</span><h2>{props.issue.title}</h2></div><Show when={props.issue.url}>{url => <a class="button-primary" href={url()} target="_blank" rel="noreferrer">Open source</a>}</Show></header><dl class="issue-details"><div><dt>State</dt><dd>{props.issue.stateLabel}</dd></div><div><dt>Assigned</dt><dd>{props.issue.assignees.map(person => person.name).join(', ') || 'Unassigned'}</dd></div><div><dt>Updated</dt><dd>{props.issue.updatedAt ? new Date(props.issue.updatedAt).toLocaleDateString() : '—'}</dd></div><div><dt>Comments</dt><dd>{props.issue.commentCount ?? '—'}</dd></div></dl><section class="issue-body"><h3>Description</h3><pre>{props.issue.body || 'No description.'}</pre></section><button class="button" onClick={() => setRaw(!raw())}>{raw() ? 'Hide raw JSON' : 'Show raw JSON'}</button><Show when={raw()}><pre class="raw-json">{JSON.stringify(props.issue.raw, null, 2)}</pre></Show></article>; }

function App() {
  const snapshot = createMemo(loadWorkspace);
  const initial = /^\/groups\/([^/]+)(?:\/tasks\/([^/]+))?/.exec(location.pathname);
  const [groupRef, setGroupRef] = createSignal<string | null>(initial?.[1] ? decodeURIComponent(initial[1]) : null);
  const [taskRef, setTaskRef] = createSignal<string | null>(initial?.[2] ? decodeURIComponent(initial[2]) : null);
  const [view, setView] = createSignal<MainView>(location.pathname === '/notes' ? 'notes' : location.pathname === '/issues' ? 'issues' : 'groups');
  const [creating, setCreating] = createSignal(false);

  // Solid 2 replaces onMount + component-level onCleanup with one lifecycle
  // callback whose return value performs teardown.
  onSettled(() => {
    const restoreLocation = () => {
      const match = /^\/groups\/([^/]+)(?:\/tasks\/([^/]+))?/.exec(location.pathname);
      setGroupRef(match?.[1] ? decodeURIComponent(match[1]) : null);
      setTaskRef(match?.[2] ? decodeURIComponent(match[2]) : null);
      setView(location.pathname === '/notes' ? 'notes' : location.pathname === '/issues' ? 'issues' : 'groups');
    };
    addEventListener('popstate', restoreLocation);
    return () => removeEventListener('popstate', restoreLocation);
  });

  const openGroup = (ref: string) => { setView('groups'); setGroupRef(ref); setTaskRef(null); history.pushState(null, '', `/groups/${encodeURIComponent(ref)}`); };
  const openTask = (ref: string) => { setTaskRef(ref); history.pushState(null, '', `/groups/${encodeURIComponent(groupRef()!)}/tasks/${encodeURIComponent(ref)}`); };
  const home = () => { setView('groups'); setGroupRef(null); setTaskRef(null); history.pushState(null, '', '/'); };
  const backToGroup = () => { setTaskRef(null); history.pushState(null, '', `/groups/${encodeURIComponent(groupRef()!)}`); };
  const selectView = (next: MainView) => { setView(next); setGroupRef(null); setTaskRef(null); history.pushState(null, '', next === 'groups' ? '/' : `/${next}`); };
  const reload = () => refresh(snapshot);

  return (
    <Errored fallback={(error, reset) => <main class="grid min-h-screen place-items-center bg-slate-50 p-6"><div class="max-w-lg rounded-2xl bg-white p-6 ring-1 ring-red-200"><h1 class="text-lg font-semibold">The new UI hit a problem</h1><p class="mt-2 text-sm text-red-700">{String(error())}</p><button class="button-primary mt-4" onClick={reset}>Try again</button></div></main>}>
      <Loading fallback={<PageSkeleton />}>
        <Show when={view() === 'notes'}><NotesWorkspace select={selectView} /></Show>
        <Show when={view() === 'issues'}><IssuesWorkspace select={selectView} /></Show>
        <Show when={view() === 'groups'}>
          <Show when={groupRef()} fallback={<GroupHome snapshot={snapshot()} open={openGroup} create={() => setCreating(true)} select={selectView} />}>
            {group => <Show when={taskRef()} fallback={<GroupWorkspace groupRef={group()} snapshot={snapshot()} back={home} openTask={openTask} changed={reload} />}>{task => <TaskWorkspace groupRef={group()} taskRef={task()} snapshot={snapshot()} back={backToGroup} openTask={openTask} changed={reload} />}</Show>}
          </Show>
        </Show>
        <Show when={creating()}><CreateGroup close={() => setCreating(false)} created={ref => { setCreating(false); reload(); openGroup(ref); }} /></Show>
      </Loading>
    </Errored>
  );
}

render(() => <App />, document.getElementById('app')!);
