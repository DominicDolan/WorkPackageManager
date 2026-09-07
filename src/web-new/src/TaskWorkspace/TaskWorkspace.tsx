import { For, Loading, Show, createMemo, createSignal, refresh } from 'solid-js';
import {
  STATUSES,
  STATUS_LABELS,
  type Priority,
  type TaskDetail,
  type TaskGroupDetail,
  type TaskGroupSummary,
} from '@shared/types';
import { api, taskAssetUrl } from '../../../web/api';
import { ComparisonViewer } from './ComparisonViewer';
import { AgentLauncher } from '../AgentLauncher/AgentLauncher';
import { Brand } from '../components/Brand';
import { InfoCard } from '../components/InfoCard';
import { PageSkeleton } from '../components/PageSkeleton';
import { StatusBadge } from '../components/StatusBadge';
import { BackIcon } from '../components/icons';
import type { WorkspaceSnapshot } from '../types/workspace';
import { UNGROUPED_REF } from '../utils/groups';
import styles from './TaskWorkspace.module.css';

export function TaskWorkspace(props: {
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
    <main class={`${styles.scope} task-workspace min-h-screen`}>
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
