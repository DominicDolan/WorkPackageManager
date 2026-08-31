import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT_HARNESSES, MODEL_TIERS, type AgentHarnessId, type ModelTier } from '../shared/types';

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
  /**
   * Prefix for generated group branch names, e.g. `group/g-3-search-rework`.
   * Kept distinct from `branchPrefix` so a group's shared branch is never
   * mistaken for one task's branch.
   */
  groupBranchPrefix: string;
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
  /**
   * Commands that must pass before a pull request may be opened — the local
   * half of CI. Empty (the default) leaves the PR button ungated, exactly as
   * before. See `CheckDefinition`.
   */
  checks: CheckDefinition[];
  /**
   * Each harness's capability tiers, resolved to a real model id — e.g.
   * `{ claude: { fast: 'haiku', standard: 'sonnet', frontier: 'opus' } }`. This
   * is the one place a concrete model name is allowed to mean "recommended":
   * everywhere else (a task's `recommendedTier`, an investigation's filing)
   * only ever names a tier, so the mapping can be retuned as model lineups
   * change without touching a task. Missing a harness, or a tier within one,
   * just means that combination has nothing to recommend.
   */
  modelTiers: Partial<Record<AgentHarnessId, Partial<Record<ModelTier, string>>>>;
}

/**
 * One command this repository wants run before a pull request is opened —
 * `bun run type-check`, `dotnet build`, `eslint .`.
 *
 * Nothing here is language-aware on purpose: a check is a command and the
 * directory to run it in, which is all one tool can honestly know about a
 * repository holding a Vue frontend, a .NET backend and a Bun CLI at once.
 *
 * Every check is run with `TASKS_BRANCH`, `TASKS_BASE` and `TASKS_REPO_ROOT` in
 * its environment, alongside `CI=true`. Most checks are about the contents of
 * the working tree and can ignore them; a check about the *shape* of the branch
 * — that it is linear, that it replays onto its base — cannot work them out for
 * itself, because the branch under test is not necessarily the checked-out one.
 */
export interface CheckDefinition {
  /** Shown in the UI and in `tasks checks` output, e.g. `frontend type-check`. */
  name: string;
  /** argv, run directly — no shell, so no quoting rules and no `&&`. */
  command: string[];
  /**
   * Working directory, relative to the **repository root** (not `.tasks/`),
   * because a check belongs to a subproject: `frontend`, `backend-modular`.
   * Defaults to the repository root.
   */
  cwd?: string;
  /**
   * Run this check only when the branch's diff against its base touches one of
   * these paths. `frontend` matches everything under it; `*` and `**` work as
   * usual. Omit to always run.
   *
   * This is what keeps a monorepo's gate usable: a backend-only branch should
   * not wait on the frontend's test suite to tell it nothing.
   */
  paths?: string[];
  /** Override the 15-minute default, in milliseconds. */
  timeoutMs?: number;
}

export const DEFAULT_CONFIG: TasksConfig = {
  branchPrefix: 'feature/',
  groupBranchPrefix: 'group/',
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
  checks: [],
  modelTiers: {},
};

export const CONFIG_FILENAME = 'tasks.config.json';

function fail(message: string): never {
  throw new Error(`${CONFIG_FILENAME}: ${message}`);
}

/** Validate one entry of `checks`. */
function checkDefinition(raw: unknown, index: number): CheckDefinition {
  const where = `checks[${index}]`;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    fail(`${where} must be an object.`);
  }
  const entry = raw as Record<string, unknown>;

  if (typeof entry.name !== 'string' || !entry.name.trim()) {
    fail(`${where}.name must be a non-empty string.`);
  }

  // A bare string is the command with no flags — accepted for convenience, and
  // split on whitespace so `"bun run lint"` does the obvious thing.
  let command: string[];
  if (typeof entry.command === 'string' && entry.command.trim()) {
    command = entry.command.trim().split(/\s+/);
  } else if (
    Array.isArray(entry.command) &&
    entry.command.length > 0 &&
    entry.command.every((part) => typeof part === 'string' && part.trim())
  ) {
    command = entry.command as string[];
  } else {
    fail(`${where}.command must be a command string or an array of non-empty strings.`);
  }

  const definition: CheckDefinition = { name: entry.name.trim(), command };

  if (entry.cwd !== undefined && entry.cwd !== null) {
    if (typeof entry.cwd !== 'string' || !entry.cwd.trim()) fail(`${where}.cwd must be a non-empty string.`);
    definition.cwd = entry.cwd;
  }

  if (entry.paths !== undefined && entry.paths !== null) {
    if (
      !Array.isArray(entry.paths) ||
      !entry.paths.every((part) => typeof part === 'string' && part.trim())
    ) {
      fail(`${where}.paths must be an array of non-empty strings.`);
    }
    definition.paths = entry.paths as string[];
  }

  if (entry.timeoutMs !== undefined && entry.timeoutMs !== null) {
    if (typeof entry.timeoutMs !== 'number' || !Number.isInteger(entry.timeoutMs) || entry.timeoutMs < 1000) {
      fail(`${where}.timeoutMs must be an integer of at least 1000 milliseconds.`);
    }
    definition.timeoutMs = entry.timeoutMs;
  }

  const unknown = Object.keys(entry).filter(
    (key) => !['name', 'command', 'cwd', 'paths', 'timeoutMs'].includes(key),
  );
  if (unknown.length) fail(`${where} has unknown key(s): ${unknown.join(', ')}.`);

  return definition;
}

/** Validate one harness's tier map within `modelTiers`. */
function modelTierMap(raw: unknown, harnessId: string): Partial<Record<ModelTier, string>> {
  const where = `modelTiers.${harnessId}`;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    fail(`${where} must be an object.`);
  }
  const entry = raw as Record<string, unknown>;

  const map: Partial<Record<ModelTier, string>> = {};
  for (const [tier, value] of Object.entries(entry)) {
    if (!(MODEL_TIERS as readonly string[]).includes(tier)) {
      fail(`${where} has unknown tier '${tier}'. Expected: ${MODEL_TIERS.join(', ')}.`);
    }
    if (typeof value !== 'string' || !value.trim()) {
      fail(`${where}.${tier} must be a non-empty string.`);
    }
    map[tier as ModelTier] = value;
  }
  return map;
}

/** Validate and coerce one raw JSON object into a full config. */
function merge(raw: Record<string, unknown>): TasksConfig {
  const config = { ...DEFAULT_CONFIG };

  for (const key of ['branchPrefix', 'groupBranchPrefix', 'checkpointPrefix', 'aioVrDir', 'aioVrBin', 'notesDir'] as const) {
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

  if (raw.checks !== undefined && raw.checks !== null) {
    if (!Array.isArray(raw.checks)) fail("'checks' must be an array.");
    config.checks = raw.checks.map((entry, index) => checkDefinition(entry, index));
  }

  if (raw.modelTiers !== undefined && raw.modelTiers !== null) {
    if (typeof raw.modelTiers !== 'object' || Array.isArray(raw.modelTiers)) {
      fail("'modelTiers' must be an object.");
    }
    const modelTiers: TasksConfig['modelTiers'] = {};
    for (const [harnessId, value] of Object.entries(raw.modelTiers as Record<string, unknown>)) {
      if (!(AGENT_HARNESSES as readonly string[]).includes(harnessId)) {
        fail(`'modelTiers' has unknown harness '${harnessId}'. Expected: ${AGENT_HARNESSES.join(', ')}.`);
      }
      modelTiers[harnessId as AgentHarnessId] = modelTierMap(value, harnessId);
    }
    config.modelTiers = modelTiers;
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
