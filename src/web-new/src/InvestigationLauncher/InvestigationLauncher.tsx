import { Loading, Show, createMemo, createSignal } from 'solid-js';
import type {
  AgentModel,
  AgentPermissionMode,
  AgentRunMode,
  Investigation,
} from '@shared/types';
import { api } from '../../../web/api';
import { AgentSettings } from '../components/AgentSettings';
import { Modal } from '../components/Modal';
import styles from './InvestigationLauncher.module.css';

export function InvestigationLauncher(props: { investigation: Investigation; close: () => void; started: () => void }) {
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
    <div class={`${styles.scope} investigation-run-summary`}><span>{props.investigation.ref}</span><strong>{props.investigation.title}</strong><p>The agent will investigate this brief, record its findings, and create tasks in the linked group. It will not change product code.</p></div>
    <Loading fallback={<p class="mt-5 text-sm text-slate-500">Checking installed agents…</p>}><AgentSettings environment={environment()} harness={chosenHarness()} setHarness={setHarness} model={model()} setModel={setModel} models={models()} mode={mode()} setMode={setMode} permission={permission()} setPermission={setPermission} unattended={false} /></Loading>
    <label class="field mt-4"><span>Extra instructions</span><textarea value={extra()} onInput={event => setExtra(event.currentTarget.value)} placeholder="Optional context for this run" /></label>
    <Show when={error()}><p class="banner mt-4">{error()}</p></Show>
    <div class="mt-5 flex justify-end"><button class="button-primary" disabled={busy()} onClick={run}>{busy() ? 'Starting…' : 'Start investigation'}</button></div>
  </Modal>;
}
