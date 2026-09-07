import { For, Show, createSignal } from 'solid-js';
import {
  AGENT_PERMISSION_MODE_LABELS,
  type AgentEnvironment,
  type AgentModel,
  type AgentPermissionMode,
  type AgentRunMode,
} from '@shared/types';
import styles from './AgentSettings.module.css';

export function AgentSettings(props: {
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
    <div class={`${styles.scope} mt-5 grid gap-4 sm:grid-cols-2`}>
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
