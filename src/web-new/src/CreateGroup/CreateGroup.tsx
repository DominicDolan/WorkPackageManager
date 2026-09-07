import { For, Show, createSignal } from 'solid-js';
import { GROUP_COLORS } from '@shared/types';
import { api } from '../../../web/api';
import { Modal } from '../components/Modal';
import styles from './CreateGroup.module.css';

export function CreateGroup(props: {
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
      <p class={`${styles.scope} modal-intro`}>Define the outcome, then give an agent the question and context it needs to investigate. The tasks it creates will be filed into this group.</p>
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
