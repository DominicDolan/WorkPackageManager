import { For, Show, createMemo, createSignal } from 'solid-js';
import { GROUP_COLORS } from '@shared/types';
import { api } from '../../../web/api';
import { Modal } from '../components/Modal';
import type { WorkspaceSnapshot } from '../types/workspace';
import styles from './CreateGroup.module.css';

export function CreateGroup(props: {
  snapshot: WorkspaceSnapshot;
  close: () => void;
  created: (ref: string) => void;
}) {
  const [name, setName] = createSignal('');
  const [description, setDescription] = createSignal('');
  const [color, setColor] = createSignal<string>(GROUP_COLORS[0]);
  const [branchName, setBranchName] = createSignal('');
  const [branchMenuOpen, setBranchMenuOpen] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  const claimedBranches = createMemo(() => new Set(
    props.snapshot.groups.map(group => group.branchName.toLowerCase()),
  ));
  const branchOptions = createMemo(() => [...props.snapshot.localBranches].sort((left, right) => {
    if (left === props.snapshot.currentBranch) return -1;
    if (right === props.snapshot.currentBranch) return 1;
    return left.localeCompare(right);
  }));
  const matchingBranches = createMemo(() => {
    const query = branchName().trim().toLowerCase();
    return branchOptions().filter(branch => !query || branch.toLowerCase().includes(query));
  });
  const selectedBranchValid = createMemo(() => {
    const branch = branchName().trim();
    return !branch || (
      props.snapshot.localBranches.includes(branch) &&
      !claimedBranches().has(branch.toLowerCase())
    );
  });

  const chooseBranch = (branch: string) => {
    if (claimedBranches().has(branch.toLowerCase())) return;
    setBranchName(branch);
    setBranchMenuOpen(false);
  };

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      const result = await api.createGroup({
        name: name(),
        description: description(),
        investigation: description(),
        color: color(),
        branchName: branchName().trim() || undefined,
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
      <div class="field mt-4">
        <label class="field-label" for="create-group-branch">Existing branch <small class={styles.optional}>(optional)</small></label>
        <div class={styles.branchPicker}>
          <input
            id="create-group-branch"
            class={styles.branchInput}
            value={branchName()}
            onInput={event => { setBranchName(event.currentTarget.value); setBranchMenuOpen(true); }}
            onFocus={() => setBranchMenuOpen(true)}
            onBlur={() => setBranchMenuOpen(false)}
            onKeyDown={event => {
              if (event.key === 'Escape') setBranchMenuOpen(false);
              if (event.key === 'Enter' && branchMenuOpen()) {
                const first = matchingBranches().find(branch => !claimedBranches().has(branch.toLowerCase()));
                if (first) { event.preventDefault(); chooseBranch(first); }
              }
            }}
            placeholder="Search local branches…"
            autocomplete="off"
            role="combobox"
            aria-expanded={branchMenuOpen() ? 'true' : 'false'}
            aria-controls="create-group-branch-options"
            aria-autocomplete="list"
          />
          <Show when={branchMenuOpen()}>
            <div id="create-group-branch-options" class={styles.branchMenu} role="listbox">
              <For each={matchingBranches()} fallback={<p class={styles.noBranches}>No branches match your search.</p>}>
                {branch => {
                  const claimed = () => claimedBranches().has(branch.toLowerCase());
                  return (
                    <button
                      type="button"
                      class={`${styles.branchOption} ${claimed() ? styles.claimed : ''}`}
                      disabled={claimed()}
                      role="option"
                      aria-selected={branchName() === branch ? 'true' : 'false'}
                      onMouseDown={event => { event.preventDefault(); chooseBranch(branch); }}
                    >
                      <code>{branch}</code>
                      <span class={styles.branchBadges}>
                        <Show when={branch === props.snapshot.currentBranch}><small class={styles.currentBadge}>Current</small></Show>
                        <Show when={claimed()}><small>Already assigned</small></Show>
                      </span>
                    </button>
                  );
                }}
              </For>
            </div>
          </Show>
        </div>
        <small class={styles.hint}>
          {selectedBranchValid()
            ? 'Select a local branch to use for this group. Leave blank to generate a new group branch.'
            : 'Choose an available branch from the results, or clear the field.'}
        </small>
      </div>
      <div class="mt-4">
        <span class="field-label">Colour</span>
        <div class="mt-2 flex gap-2">
          <For each={GROUP_COLORS}>{value => (
            <button aria-label={value} class={`h-8 w-8 rounded-full ring-offset-2 ${color() === value ? 'ring-2 ring-slate-700' : ''}`} style={{ background: value }} onClick={() => setColor(value)} />
          )}</For>
        </div>
      </div>
      <Show when={error()}><p class="banner mt-4">{error()}</p></Show>
      <div class="mt-5 flex justify-end gap-2"><button class="button" onClick={props.close}>Cancel</button><button class="button-primary" disabled={!name().trim() || !selectedBranchValid() || busy()} onClick={submit}>{busy() ? 'Creating…' : 'Create group'}</button></div>
    </Modal>
  );
}
