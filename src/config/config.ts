import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Per-repository settings, read from `.tasks/tasks.config.json`.
 *
 * Every key has a default, so the file is optional and a partial file is fine —
 * this is what lets `tasks init` scaffold a workspace with nothing but a data
 * directory and still behave sensibly. Environment variables continue to
 * override the file (see `paths.ts`), because they are how a one-off run points
 * at a different database or port without editing tracked-adjacent state.
 */
export interface TasksConfig {
  /** Prefix for generated branch names, e.g. `feature/t-12-make-it-responsive`. */
  branchPrefix: string;
  /** Prefix for generated aio-vr checkpoint names, e.g. `task-t-12`. */
  checkpointPrefix: string;
  /**
   * PR base branch. `null` resolves it live: `gh repo view`, then whichever of
   * `main` / `master` exists locally.
   */
  baseBranch: string | null;
  /** aio-vr workspace, resolved relative to `.tasks/`. */
  aioVrDir: string;
  /** The aio-vr executable to drive. */
  aioVrBin: string;
  /**
   * Where notes live, resolved relative to `.tasks/`. Markdown files and their
   * attachments, and normally a Git repository in its own right — which is why
   * the default sits beside the workspace rather than inside it, and why a
   * sibling of the repo (`../../SomethingNotes`) is a perfectly ordinary value.
   */
  notesDir: string;
  /**
   * Commit each notes change as it is made, when the notes folder is a Git
   * repository. The point of keeping notes on disk is that their history is
   * Git's; leaving every edit uncommitted would defeat it. Set false to commit
   * by hand with `tasks notes sync`.
   */
  notesAutoCommit: boolean;
  /** Port the API/web server listens on. */
  apiPort: number;
  /** Port `tasks web --dev` serves the Vite dev server on. */
  webPort: number;
  /**
   * Command that writes PR descriptions from a branch's commit history. The
   * prompt is appended as one final argument, so the array form is how a
   * different agent's flags get supplied — the default's `--no-tools` is what
   * makes it safe to fire from a web request, and another CLI will spell that
   * differently. `null` disables the feature; the Branches view then reports it
   * as unavailable rather than failing a request.
   */
  prAgent: string[] | null;
  /**
   * Command that opens a terminal window, with the agent's argv appended to it —
   * `["kitty", "--hold", "-e"]` runs `kitty --hold -e claude "/work-task T-1"`.
   * This is how "open a window with the agent running in it" is spelled, and
   * every emulator spells it differently, hence the array.
   *
   * `null` autodetects the first of a handful of known emulators on PATH. Set it
   * explicitly to pin one, or to pass extra flags (a class name for the window
   * manager, a profile, a font size).
   */
  agentTerminal: string[] | null;
}

export const DEFAULT_CONFIG: TasksConfig = {
  branchPrefix: 'feature/',
  checkpointPrefix: 'task-',
  baseBranch: null,
  aioVrDir: '../.aio-vr',
  aioVrBin: 'aio-vr',
  notesDir: '../.notes',
  notesAutoCommit: true,
  apiPort: 5199,
  webPort: 5200,
  prAgent: ['pi', '--no-session', '-p', '--no-tools'],
  agentTerminal: null,
};

export const CONFIG_FILENAME = 'tasks.config.json';

function fail(message: string): never {
  throw new Error(`${CONFIG_FILENAME}: ${message}`);
}

/** Validate and coerce one raw JSON object into a full config. */
function merge(raw: Record<string, unknown>): TasksConfig {
  const config = { ...DEFAULT_CONFIG };

  for (const key of ['branchPrefix', 'checkpointPrefix', 'aioVrDir', 'aioVrBin', 'notesDir'] as const) {
    const value = raw[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string' || !value.trim()) fail(`'${key}' must be a non-empty string.`);
    config[key] = value;
  }

  if (raw.baseBranch !== undefined) {
    if (raw.baseBranch === null) {
      config.baseBranch = null;
    } else if (typeof raw.baseBranch !== 'string' || !raw.baseBranch.trim()) {
      fail("'baseBranch' must be a non-empty string, or null.");
    } else {
      config.baseBranch = raw.baseBranch;
    }
  }

  // Both of these are "a command and its flags, or null to switch the feature
  // off", so they validate identically.
  for (const key of ['prAgent', 'agentTerminal'] as const) {
    const value = raw[key];
    if (value === undefined) continue;
    if (value === null) {
      config[key] = null;
    } else if (typeof value === 'string') {
      // A bare string is the command with no flags — accepted for convenience.
      if (!value.trim()) fail(`'${key}' must not be empty.`);
      config[key] = [value];
    } else if (
      Array.isArray(value) &&
      value.length > 0 &&
      value.every((part) => typeof part === 'string' && part.trim())
    ) {
      config[key] = value as string[];
    } else {
      fail(`'${key}' must be a command string, an array of non-empty strings, or null.`);
    }
  }

  if (raw.notesAutoCommit !== undefined && raw.notesAutoCommit !== null) {
    if (typeof raw.notesAutoCommit !== 'boolean') fail("'notesAutoCommit' must be true or false.");
    config.notesAutoCommit = raw.notesAutoCommit;
  }

  for (const key of ['apiPort', 'webPort'] as const) {
    const value = raw[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65535) {
      fail(`'${key}' must be an integer port between 1 and 65535.`);
    }
    config[key] = value;
  }

  const unknown = Object.keys(raw).filter((key) => !(key in DEFAULT_CONFIG));
  if (unknown.length) {
    // Loud rather than ignored: a typo'd key that silently does nothing is how
    // someone spends an afternoon wondering why their branch prefix is unused.
    fail(`unknown key(s): ${unknown.join(', ')}. Expected: ${Object.keys(DEFAULT_CONFIG).join(', ')}.`);
  }

  return config;
}

export function loadConfig(tasksDir: string): TasksConfig {
  const path = join(tasksDir, CONFIG_FILENAME);
  if (!existsSync(path)) return { ...DEFAULT_CONFIG };

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(`could not be parsed as JSON — ${error instanceof Error ? error.message : String(error)}`);
  }

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    fail('must contain a JSON object.');
  }

  return merge(raw as Record<string, unknown>);
}
