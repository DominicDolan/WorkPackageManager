import { For, Loading, Show, createMemo, createSignal, refresh, type Element } from 'solid-js';
import {
  GROUP_RUN_STATUS_LABELS,
  INVESTIGATION_STATUS_LABELS,
  groupRunActive,
  nextWorkableTask,
  type CombinedBranchDetail,
  type Investigation,
  type InvestigationDetail,
  type Task,
  type TaskGroupDetail,
} from '@shared/types';
import { api } from '../../../web/api';
import { AgentLauncher } from '../AgentLauncher/AgentLauncher';
import { InvestigationLauncher } from '../InvestigationLauncher/InvestigationLauncher';
import { Brand } from '../components/Brand';
import { InfoCard } from '../components/InfoCard';
import { PageSkeleton } from '../components/PageSkeleton';
import { StatusBadge } from '../components/StatusBadge';
import { BackIcon } from '../components/icons';
import type { WorkspaceSnapshot } from '../types/workspace';
import { UNGROUPED_REF } from '../utils/groups';
import styles from './GroupWorkspace.module.css';

export function GroupWorkspace(props: {
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
    <main class={`${styles.scope} workspace-page min-h-screen text-slate-950`}>
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
