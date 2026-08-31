import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { workspace } from '../config/paths';
import { getDb, nowIso } from './db';
import {
  AGENT_COMMANDS,
  AGENT_HARNESSES,
  AGENT_PERMISSION_MODES,
  AGENT_RUN_MODES,
  type AgentCommand,
  type AgentEnvironment,
  type AgentHarnessId,
  type AgentHarnessInfo,
  type AgentModel,
  type AgentPermissionMode,
  type AgentRun,
  type AgentRunDetail,
  type AgentRunMode,
  type AgentRunStatus,
} from '../shared/types';

/**
 * Running a coding agent against an issue or a task, from the UI.
 *
 * Two things make this simpler than it looks. First, the prompt is the same for
 * both harnesses: `plan-tasks` and `work-task`'s instructions live as Markdown
 * in this package's `prompts/` folder (see `buildPrompt`) and are inlined into
 * one message, so the same string drives either. Second, the two run modes are
 * genuinely different products rather than two settings of one:
 *
 * - **terminal** opens a real terminal window with the agent interactive inside
 *   it. The agent can ask questions and you can answer them. Nothing is captured
 *   here because the terminal is the session — this app only launches it.
 * - **print** runs `-p` headless, detached, with stdout and stderr pumped into a
 *   log file the UI streams back. Nobody is at a terminal to approve anything,
 *   so a headless run has to be told up front that it may act unattended.
 *
 * Orthogonal to both is Claude Code's permission mode, which is a property of
 * the session rather than of how it was launched: `auto` is as meaningful in a
 * terminal window — where it is what Shift+Tab reaches — as it is headless.
 *
 * Adding a harness is one entry in `HARNESSES`: what it is called, how it takes
 * a model, how it spells "run this and exit", and how (or whether) it can list
 * its own models.
 */

const ws = workspace();

/** Where `print` runs write their output. Beside the database, not inside it. */
const LOG_DIR = join(ws.tasksDir, 'data', 'agent-runs');

/** The tail of a log the API will return in one response. */
const MAX_OUTPUT_CHARS = 400_000;

/** How long a model listing is trusted before the CLI is asked again. */
const MODEL_CACHE_MS = 5 * 60_000;

/** Long enough for a model catalogue refresh, short enough to not hang a tab. */
const LIST_MODELS_TIMEOUT_MS = 30_000;

interface Ran {
  code: number;
  stdout: string;
  stderr: string;
}

function runSync(command: string[], timeoutMs?: number): Ran {
  const result = Bun.spawnSync(command, {
    cwd: ws.repoRoot,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    ...(timeoutMs ? { timeout: timeoutMs } : {}),
  });
  return {
    code: result.exitCode ?? 1,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function onPath(bin: string): boolean {
  return runSync(['which', bin], 10_000).code === 0;
}

/* ------------------------------------------------------------- harnesses */

interface HarnessDef {
  id: AgentHarnessId;
  label: string;
  bin: string;
  /** True when `models()` shells out and the UI should fetch it separately. */
  modelsLazy: boolean;
  models(): AgentModel[];
  /**
   * The argv for one run, minus any terminal wrapper. `model` is empty when the
   * harness's own default should stand.
   */
  argv(input: {
    prompt: string;
    model: string;
    /** Claude's thinking budget; omitted when the harness does not support it. */
    effort: 'low' | null;
    mode: AgentRunMode;
    permissionMode: AgentPermissionMode;
    /** The conversation id to create, so the session can be reopened later. */
    sessionId: string;
  }): string[];
  /**
   * The argv that reopens a session this harness created, always interactive —
   * resuming exists so a person can carry on the conversation, and a headless
   * resume would have nobody to carry it on with.
   */
  resumeArgv(sessionId: string): string[];
}

/**
 * Claude Code cannot list its models — `claude models` is a prompt, not a
 * command — so these are the aliases it documents, which resolve to the current
 * model of each tier rather than pinning a dated id.
 */
const CLAUDE_MODELS: AgentModel[] = [
  { id: '', label: 'Default (whatever the session is configured for)', group: null },
  { id: 'opus', label: 'Opus — most capable', group: 'Aliases' },
  { id: 'sonnet', label: 'Sonnet — balanced', group: 'Aliases' },
  { id: 'fable', label: 'Fable', group: 'Aliases' },
  { id: 'haiku', label: 'Haiku — fastest, cheapest', group: 'Aliases' },
];

const HARNESSES: HarnessDef[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    bin: 'claude',
    modelsLazy: false,
    models: () => CLAUDE_MODELS,
    argv: ({ prompt, model, effort, mode, permissionMode, sessionId }) => {
      const argv = ['claude'];
      // Naming the conversation up front is what makes Resume possible. The
      // harness creates it under this id, so nothing has to be discovered.
      argv.push('--session-id', sessionId);
      if (model) argv.push('--model', model);
      if (effort) argv.push('--effort', effort);
      // `manual` is Claude's own default, and saying so explicitly would break
      // against a build that spells these modes differently — so it is the one
      // value expressed by passing nothing.
      if (permissionMode !== 'manual') argv.push('--permission-mode', permissionMode);
      // The flag governs an interactive session too, which is the whole point of
      // offering it here: `auto` is what the terminal UI reaches with Shift+Tab,
      // available at launch instead of two keystrokes in.
      if (mode === 'print') argv.push('--print');
      argv.push(prompt);
      return argv;
    },
    resumeArgv: (sessionId) => ['claude', '--resume', sessionId],
  },
  {
    id: 'pi',
    label: 'pi',
    bin: 'pi',
    // `pi --list-models` prints several hundred models across every provider it
    // knows, and takes long enough to be worth fetching only when asked for.
    modelsLazy: true,
    models: listPiModels,
    // `pi` has no equivalent of a permission mode — `--approve` is about trusting
    // project files, not about what the agent may do — so it is ignored here
    // rather than approximated.
    argv: ({ prompt, model, mode, sessionId }) => {
      const argv = ['pi', '--session-id', sessionId];
      if (model) argv.push('--model', model);
      if (mode === 'print') argv.push('--print');
      argv.push(prompt);
      return argv;
    },
    // `pi --session-id` creates the session if it is missing and opens it if it
    // is not, so reopening is the same flag with no prompt after it.
    resumeArgv: (sessionId) => ['pi', '--session-id', sessionId],
  },
];

function harness(id: string): HarnessDef {
  const found = HARNESSES.find((one) => one.id === id);
  if (!found) throw new Error(`Unknown harness '${id}'. Expected: ${AGENT_HARNESSES.join(', ')}.`);
  return found;
}

/**
 * `pi --list-models` prints a fixed-width table: provider, model, then columns
 * this does not need. Split on runs of whitespace and keep the first two — a
 * model id never contains a space, so that is unambiguous.
 */
function listPiModels(): AgentModel[] {
  const result = runSync(['pi', '--list-models'], LIST_MODELS_TIMEOUT_MS);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || 'pi --list-models failed.');
  }

  const models: AgentModel[] = [{ id: '', label: 'Default (pi’s configured model)', group: null }];
  for (const line of result.stdout.split('\n')) {
    const [provider, model] = line.trim().split(/\s+/);
    if (!provider || !model) continue;
    // The header row names its own columns; nothing else looks like this.
    if (provider === 'provider' && model === 'model') continue;
    models.push({ id: `${provider}/${model}`, label: model, group: provider });
  }

  if (models.length === 1) throw new Error('pi --list-models returned no models.');
  return models;
}

const modelCache = new Map<AgentHarnessId, { at: number; models: AgentModel[] }>();

export function harnessModels(id: string): AgentModel[] {
  const definition = harness(id);
  const cached = modelCache.get(definition.id);
  if (cached && Date.now() - cached.at < MODEL_CACHE_MS) return cached.models;

  const models = definition.models();
  modelCache.set(definition.id, { at: Date.now(), models });
  return models;
}

/* -------------------------------------------------------------- terminal */

/**
 * How each emulator spells "run this argv in a new window". The order is the
 * detection order: a terminal that keeps its window open after the agent exits
 * comes first, because a window that vanishes the moment something goes wrong
 * is the one failure mode that leaves nothing at all behind.
 */
const TERMINALS: string[][] = [
  ['kitty', '--hold'],
  ['wezterm', 'start', '--'],
  ['ghostty', '-e'],
  ['konsole', '--hold', '-e'],
  ['alacritty', '-e'],
  ['gnome-terminal', '--'],
  ['foot'],
  ['xterm', '-hold', '-e'],
];

let detectedTerminal: string[] | null | undefined;

/** The configured terminal, or the first known one on PATH. */
export function terminalCommand(): string[] | null {
  if (ws.config.agentTerminal) return ws.config.agentTerminal;
  if (detectedTerminal !== undefined) return detectedTerminal;

  detectedTerminal = TERMINALS.find((candidate) => onPath(candidate[0]!)) ?? null;
  return detectedTerminal;
}

export function agentEnvironment(): AgentEnvironment {
  const terminal = terminalCommand();
  const harnesses: AgentHarnessInfo[] = HARNESSES.map((definition) => ({
    id: definition.id,
    label: definition.label,
    bin: definition.bin,
    available: onPath(definition.bin),
    modelsLazy: definition.modelsLazy,
  }));

  return {
    harnesses,
    terminal: terminal ? terminal[0]! : null,
    terminalAvailable: terminal !== null,
    modelTiers: ws.config.modelTiers,
  };
}

/* ---------------------------------------------------------------- prompt */

/**
 * Read one command's instructions — `prompts/<command>.md`, shipped with this
 * package — with no `$1` substitution done yet. A workspace may override one
 * by placing its own at `.tasks/prompts/<command>.md`; that is checked first,
 * so a repository can customize a procedure without patching the package.
 */
function promptTemplate(command: AgentCommand): string {
  const override = join(ws.tasksDir, 'prompts', `${command}.md`);
  const path = existsSync(override) ? override : join(ws.promptsDir, `${command}.md`);
  return readFileSync(path, 'utf8');
}

/**
 * The message the agent receives.
 *
 * There used to be a slash command for this — `/plan-tasks`, `/work-task` —
 * installed separately in whatever harness's own commands folder. That made a
 * run depend on the user's global config rather than this repository, so
 * instead the full instructions are inlined here: the harness gets one long
 * message with everything it needs, and nothing has to be installed beyond the
 * `claude` or `pi` binary itself.
 *
 * `work-group` is a loop around `work-task`'s procedure, so its template gets
 * that procedure's own Markdown spliced in whole rather than telling the agent
 * to go find it — there is nowhere reliable for it to look, since the package
 * may not be installed anywhere near the repository being worked on.
 */
export function buildPrompt(command: AgentCommand, target: string, extra: string): string {
  let body = promptTemplate(command).replace(/\$1/g, target.trim());
  if (command === 'work-group') {
    // Left unsubstituted deliberately: the appendix's `$1` means "whichever
    // task the loop is on", not the group ref this template's own `$1` means.
    body = body.replace('$WORK_TASK_PROCEDURE', promptTemplate('work-task'));
  }

  const note = extra.trim();
  if (!note) return body;
  return `${body}\n\nExtra instructions from the user, which take precedence over any default\nthis command would otherwise pick:\n\n${note}`;
}

/* ------------------------------------------------------------------ runs */

interface RunRow {
  id: number;
  harness: string;
  model: string;
  mode: string;
  command: string;
  subject_kind: string;
  subject_ref: string;
  prompt: string;
  argv_json: string;
  pid: number | null;
  session_id: string | null;
  status: string;
  exit_code: number | null;
  log_path: string | null;
  created_at: string;
  finished_at: string | null;
}

function toRun(row: RunRow): AgentRun {
  return {
    id: row.id,
    harness: row.harness as AgentHarnessId,
    model: row.model,
    mode: row.mode as AgentRunMode,
    command: row.command as AgentCommand,
    subjectKind: row.subject_kind,
    subjectRef: row.subject_ref,
    prompt: row.prompt,
    argv: JSON.parse(row.argv_json) as string[],
    sessionId: row.session_id,
    pid: row.pid,
    status: row.status as AgentRunStatus,
    exitCode: row.exit_code,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  };
}

function readRow(id: number): RunRow {
  const row = getDb()
    .query<RunRow, { $id: number }>('SELECT * FROM agent_runs WHERE id = $id')
    .get({ $id: id });
  if (!row) throw new Error(`No agent run with id ${id}.`);
  return row;
}

/**
 * Told when a run reaches a final state, whatever put it there.
 *
 * This is what makes an unattended group run possible: the agent is a child of
 * this process, so its exit is observed directly rather than guessed at from a
 * timer or reported back by a hook. Registered rather than imported so the
 * orchestrator can depend on this module without this module depending on it.
 */
type SettledListener = (id: number, status: AgentRunStatus) => void;

const settledListeners = new Set<SettledListener>();

export function onRunSettled(listener: SettledListener): void {
  settledListeners.add(listener);
}

function finish(id: number, status: AgentRunStatus, exitCode: number | null): void {
  const changed = getDb()
    .query(
      `UPDATE agent_runs SET status = $status, exit_code = $code, finished_at = $at
        WHERE id = $id AND status IN ('launched', 'running')`,
    )
    .run({ $id: id, $status: status, $code: exitCode, $at: nowIso() }).changes;

  // A run only settles once. Without this guard a stopped run that then exits
  // would announce itself twice, and a loop listening would launch two tasks.
  if (!changed) return;

  // Deferred: a listener starting the next agent must not do it inside the
  // stream-pump callback that is still finishing this one.
  setTimeout(() => {
    for (const listener of settledListeners) {
      try {
        listener(id, status);
      } catch {
        // A listener that throws must not take the run's own bookkeeping with it.
      }
    }
  }, 0);
}

/** Live children, so a run started in this process can be stopped by id. */
const live = new Map<number, Bun.Subprocess>();

/**
 * A `running` row whose process is gone is a lie the next page load would
 * repeat forever. Runs are children of this server, so restarting it ends them;
 * anything still `running` at startup, or with a pid nothing answers to, is
 * settled here instead of being believed.
 */
export function reconcileRuns(): void {
  const stale = getDb()
    .query<RunRow, []>("SELECT * FROM agent_runs WHERE status = 'running'")
    .all();

  for (const row of stale) {
    if (row.pid !== null && alive(row.pid)) continue;
    finish(row.id, 'stopped', null);
  }
}

function alive(pid: number): boolean {
  try {
    // Signal 0 performs the permission and existence checks without delivering.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export interface StartRunInput {
  harness: string;
  model: string;
  mode: AgentRunMode;
  command: AgentCommand;
  target: string;
  extra: string;
  subjectKind: string;
  subjectRef: string;
  /** How much the agent may do without asking. Claude Code only. */
  permissionMode: AgentPermissionMode;
}

export function startRun(input: StartRunInput): AgentRun {
  const definition = harness(input.harness);
  if (!AGENT_RUN_MODES.includes(input.mode)) throw new Error(`Unknown run mode '${input.mode}'.`);
  if (!AGENT_COMMANDS.includes(input.command)) throw new Error(`Unknown command '${input.command}'.`);
  if (!AGENT_PERMISSION_MODES.includes(input.permissionMode)) {
    throw new Error(`Unknown permission mode '${input.permissionMode}'.`);
  }
  if (!onPath(definition.bin)) {
    throw new Error(`${definition.bin} is not on PATH, so it cannot be run from here.`);
  }

  const prompt = buildPrompt(input.command, input.target, input.extra);
  // Chosen here, not read back afterwards. Both harnesses accept a supplied id,
  // and picking "the newest transcript" would race with any other window the
  // user happens to have open in this repository.
  const sessionId = crypto.randomUUID();
  // Task descriptions and notes are the handoff from the investigating agent.
  // Spend less of a task agent's budget rediscovering that work; investigation
  // runs deliberately retain their harness default.
  const effort = input.command === 'work-task' && definition.id === 'claude' ? 'low' : null;
  const agentArgv = definition.argv({
    prompt,
    model: input.model,
    effort,
    mode: input.mode,
    permissionMode: input.permissionMode,
    sessionId,
  });

  let argv = agentArgv;
  if (input.mode === 'terminal') {
    const terminal = terminalCommand();
    if (!terminal) {
      throw new Error(
        'No terminal emulator was found, so an interactive run cannot be opened. ' +
          'Set "agentTerminal" in .tasks/tasks.config.json, or run headless with -p.',
      );
    }
    argv = [...terminal, ...agentArgv];
  }

  const createdAt = nowIso();
  const row = getDb()
    .query<{ id: number }, Record<string, string | number | null>>(
      `INSERT INTO agent_runs
         (harness, model, mode, command, subject_kind, subject_ref, prompt, argv_json,
          pid, session_id, status, log_path, created_at)
       VALUES ($harness, $model, $mode, $command, $kind, $ref, $prompt, $argv,
               NULL, $session, $status, $log, $at)
       RETURNING id`,
    )
    .get({
      $harness: definition.id,
      $model: input.model,
      $mode: input.mode,
      $command: input.command,
      $kind: input.subjectKind,
      $ref: input.subjectRef,
      $prompt: prompt,
      $argv: JSON.stringify(argv),
      $session: sessionId,
      $status: input.mode === 'terminal' ? 'launched' : 'running',
      $log: null,
      $at: createdAt,
    })!;

  try {
    if (input.mode === 'terminal') {
      spawnTerminal(row.id, argv);
    } else {
      spawnHeadless(row.id, argv);
    }
  } catch (error) {
    finish(row.id, 'failed', null);
    throw error;
  }

  return toRun(readRow(row.id));
}

/**
 * Launching a window is fire-and-forget: the emulator forks its own process
 * tree, so its exit code says nothing about the agent inside it, and waiting on
 * it would only tie the window's lifetime to this server's. Unref'd for the
 * same reason — the terminal outlives `tasks web`.
 */
function spawnTerminal(id: number, argv: string[]): void {
  const child = Bun.spawn(argv, {
    cwd: ws.repoRoot,
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'pipe',
    env: { ...process.env, TASKS_DIR: ws.tasksDir },
  });
  child.unref();

  getDb()
    .query('UPDATE agent_runs SET pid = $pid WHERE id = $id')
    .run({ $id: id, $pid: child.pid });

  // The emulator exits immediately on success. A non-zero exit means the window
  // never opened at all, and its stderr is the only explanation there will be.
  void child.exited.then(async (code) => {
    if (code === 0) return;
    const stderr = child.stderr instanceof ReadableStream ? await new Response(child.stderr).text() : '';
    await Bun.write(logPath(id), stderr || `Terminal exited ${code}.`);
    getDb().query('UPDATE agent_runs SET log_path = $log WHERE id = $id')
      .run({ $id: id, $log: logPath(id) });
    finish(id, 'failed', code);
  });
}

function logPath(id: number): string {
  return join(LOG_DIR, `${id}.log`);
}

/**
 * Headless runs are detached from any terminal, so their output has to go
 * somewhere durable — a file, streamed as it arrives rather than buffered until
 * exit, because a `/work-task` run takes minutes and watching it is the point.
 */
function spawnHeadless(id: number, argv: string[]): void {
  mkdirSync(LOG_DIR, { recursive: true });
  const path = logPath(id);
  const sink = Bun.file(path).writer();

  const child = Bun.spawn(argv, {
    cwd: ws.repoRoot,
    // Never inherit: there is no terminal here, and an agent that finds one
    // would be free to block on a prompt nobody can answer.
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, TASKS_DIR: ws.tasksDir },
  });

  live.set(id, child);
  getDb()
    .query('UPDATE agent_runs SET pid = $pid, log_path = $log WHERE id = $id')
    .run({ $id: id, $pid: child.pid, $log: path });

  // Read chunk by chunk rather than awaiting the whole stream: a `/work-task`
  // run takes minutes, and the log is worth watching while it does.
  const pump = async (stream: ReadableStream<Uint8Array> | undefined | null): Promise<void> => {
    if (!stream) return;
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) {
        sink.write(value);
        sink.flush();
      }
    }
  };

  void Promise.all([
    pump(child.stdout as ReadableStream<Uint8Array>),
    pump(child.stderr as ReadableStream<Uint8Array>),
  ])
    .catch(() => {})
    .then(async () => {
      const code = await child.exited;
      await sink.end();
      live.delete(id);
      // A run killed by `stopRun` has already been recorded as stopped; do not
      // overwrite that with the SIGTERM exit it produced.
      const current = readRow(id);
      if (current.status === 'running') finish(id, code === 0 ? 'succeeded' : 'failed', code);
    });
}

export function stopRun(id: number): AgentRun {
  const row = readRow(id);
  if (row.status !== 'running' && row.status !== 'launched') {
    throw new Error(`Run ${id} is not running.`);
  }

  const child = live.get(id);
  if (child) {
    child.kill();
  } else if (row.pid !== null && alive(row.pid)) {
    try {
      process.kill(row.pid, 'SIGTERM');
    } catch {
      // Already gone between the check and the signal; the row still settles.
    }
  }

  finish(id, 'stopped', null);
  return toRun(readRow(id));
}

/**
 * Reopen a run's conversation in a terminal window.
 *
 * Always a new window, and always interactive: resuming exists so a person can
 * read what the agent did and carry on with it. The original run row is left
 * exactly as it was — this does not create a run, because it is not one. It is
 * the same conversation, opened again, and a second row would make the history
 * claim the agent was launched twice.
 */
export function resumeRun(id: number): AgentRun {
  const row = readRow(id);
  const definition = harness(row.harness);

  if (!row.session_id) {
    throw new Error(
      `Run ${id} was launched before sessions were recorded, so there is no conversation to reopen. ` +
        'Runs started from now on can be resumed.',
    );
  }
  if (!onPath(definition.bin)) {
    throw new Error(`${definition.bin} is not on PATH, so the session cannot be reopened.`);
  }

  const terminal = terminalCommand();
  if (!terminal) {
    throw new Error(
      'No terminal emulator was found, so the session cannot be reopened. ' +
        'Set "agentTerminal" in .tasks/tasks.config.json.',
    );
  }

  // Reuses the launch path's fire-and-forget spawn for the same reason: the
  // emulator forks its own tree, and the window must outlive this server.
  const child = Bun.spawn([...terminal, ...definition.resumeArgv(row.session_id)], {
    cwd: ws.repoRoot,
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
    env: { ...process.env, TASKS_DIR: ws.tasksDir },
  });
  child.unref();

  return toRun(row);
}

export function listRuns(filter: { subjectKind?: string; subjectRef?: string; limit?: number } = {}): AgentRun[] {
  const clauses: string[] = [];
  const params: Record<string, string | number> = { $limit: filter.limit ?? 50 };
  if (filter.subjectKind) {
    clauses.push('subject_kind = $kind');
    params.$kind = filter.subjectKind;
  }
  if (filter.subjectRef) {
    clauses.push('subject_ref = $ref');
    params.$ref = filter.subjectRef;
  }

  return getDb()
    .query<RunRow, typeof params>(
      `SELECT * FROM agent_runs
        ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
        ORDER BY id DESC LIMIT $limit`,
    )
    .all(params)
    .map(toRun);
}

/** One run with the tail of its log. Read from disk on every request — the file
 *  is being appended to by a child process as this is called. */
export async function getRun(id: number): Promise<AgentRunDetail> {
  const row = readRow(id);
  const run = toRun(row);

  if (!row.log_path) return { ...run, output: '', truncated: false };

  const file = Bun.file(row.log_path);
  if (!(await file.exists())) return { ...run, output: '', truncated: false };

  const text = await file.text();
  const truncated = text.length > MAX_OUTPUT_CHARS;
  return { ...run, output: truncated ? text.slice(-MAX_OUTPUT_CHARS) : text, truncated };
}
