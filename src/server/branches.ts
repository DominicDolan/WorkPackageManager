import { workspace } from '../config/paths';
import type { BranchCommit, BranchGitInfo, ToolAvailability } from '../shared/types';

/**
 * Everything that shells out on behalf of the Branches view: reading a branch's
 * history from Git, asking the configured agent to write a PR description from
 * it, and handing the result to `gh` to open the PR.
 *
 * All three run detached from any terminal — no stdio is inherited, so nothing
 * here can block on a prompt. The agent and `gh` are both given hard timeouts,
 * because an agent that stalls would otherwise hold the HTTP request open until
 * the server's own idle timeout killed it with no useful message.
 *
 * Which agent, and with which flags, is per-repository (`prAgent` in
 * tasks.config.json).
 */

const ws = workspace();

/** How long the agent may spend writing a description before we give up on it. */
const AGENT_TIMEOUT_MS = 180_000;
/** `gh` only makes a couple of API calls, but a push can be slow. */
const GH_TIMEOUT_MS = 120_000;

export interface Ran {
  code: number;
  stdout: string;
  stderr: string;
  /** True when the child was killed for exceeding its timeout. */
  timedOut: boolean;
}

function runSync(command: string[], timeoutMs?: number): Ran {
  const result = Bun.spawnSync(command, {
    cwd: ws.repoRoot,
    // Never inherit stdio: an interactive prompt would hang the request.
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    ...(timeoutMs ? { timeout: timeoutMs } : {}),
  });

  return {
    code: result.exitCode ?? 1,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    // Bun reports a timeout kill as a signal rather than an exit code.
    timedOut: result.signalCode === 'SIGTERM' || result.signalCode === 'SIGKILL',
  };
}

const git = (args: string[]) => runSync(['git', ...args]);

export function currentBranch(): string | null {
  const result = git(['branch', '--show-current']);
  return result.code === 0 && result.stdout.trim() ? result.stdout.trim() : null;
}

export function branchExists(branch: string): boolean {
  return git(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]).code === 0;
}

/** Any resolvable ref, not just a local branch — so a base that exists only as
 *  `origin/master` (a fresh clone, before the combine's fetch) still works. */
export function refExists(ref: string): boolean {
  return git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).code === 0;
}

/** The repository's default branch, as GitHub sees it — the natural PR base
 *  when a combined branch has no recorded one. Falls back to `master`. */
export function defaultBaseBranch(): string {
  if (ws.config.baseBranch) return ws.config.baseBranch;

  const viewed = runSync(['gh', 'repo', 'view', '--json', 'defaultBranchRef', '-q',
    '.defaultBranchRef.name'], 30_000);
  const name = viewed.stdout.trim();
  if (viewed.code === 0 && name) return name;

  for (const candidate of ['main', 'master']) {
    if (branchExists(candidate)) return candidate;
  }
  return 'master';
}

/** A fetch is a network round trip, and an unreachable remote must fail rather
 *  than hang the request. */
const FETCH_TIMEOUT_MS = 120_000;

export interface BaseRefresh {
  /** False when the repository has no `origin` — a local-only repo is fine. */
  fetched: boolean;
  /** True when the local base actually moved to catch up with `origin`. */
  advanced: boolean;
  /** Set when the local base is ahead of `origin` — unpushed commits ride along. */
  aheadOfRemote: boolean;
}

/**
 * Bring the local base branch up to date with `origin` before anything is cut
 * from it.
 *
 * A delivery branch built on a stale base produces a PR full of the diff
 * between the two, so this runs before the branch is created rather than being
 * left to the user. It only ever fast-forwards: if the local base has commits
 * `origin` does not, that is the user's business and the combine proceeds on
 * top of them, and if the two have genuinely diverged the combine stops rather
 * than guess which side to keep.
 *
 * The caller must have checked the working tree is clean — updating a base that
 * happens to be the checked-out branch is a real merge.
 */
export function refreshBaseBranch(base: string): BaseRefresh {
  const idle: BaseRefresh = { fetched: false, advanced: false, aheadOfRemote: false };

  const remotes = git(['remote']).stdout.split('\n').map((line) => line.trim());
  if (!remotes.includes('origin')) {
    if (!branchExists(base)) throw new Error(`Base branch '${base}' does not exist locally.`);
    return idle;
  }

  const fetched = runSync(['git', 'fetch', 'origin', base], FETCH_TIMEOUT_MS);
  if (fetched.timedOut) {
    throw new Error(`Fetching '${base}' from origin timed out, so it could not be brought up to date.`);
  }
  if (fetched.code !== 0) {
    throw new Error(
      `Could not fetch '${base}' from origin, so the delivery branch would be cut from a stale base: ${
        fetched.stderr.trim() || `git fetch exited ${fetched.code}`}`,
    );
  }

  const remoteSha = git(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${base}`]).stdout.trim();
  if (!remoteSha) {
    // A base that exists only locally — nothing to catch up with.
    if (!branchExists(base)) throw new Error(`Base branch '${base}' exists neither locally nor on origin.`);
    return { fetched: true, advanced: false, aheadOfRemote: false };
  }

  if (!branchExists(base)) {
    const created = git(['branch', base, `origin/${base}`]);
    if (created.code !== 0) {
      throw new Error(created.stderr.trim() || `Could not create '${base}' from origin/${base}.`);
    }
    return { fetched: true, advanced: true, aheadOfRemote: false };
  }

  const localSha = git(['rev-parse', '--verify', `refs/heads/${base}`]).stdout.trim();
  if (localSha === remoteSha) return { fetched: true, advanced: false, aheadOfRemote: false };

  const localIsBehind = git(['merge-base', '--is-ancestor', localSha, remoteSha]).code === 0;
  if (!localIsBehind) {
    const remoteIsBehind = git(['merge-base', '--is-ancestor', remoteSha, localSha]).code === 0;
    if (remoteIsBehind) return { fetched: true, advanced: false, aheadOfRemote: true };
    throw new Error(
      `Local '${base}' has diverged from origin/${base} — they each have commits the other does not. ` +
      `Reconcile '${base}' by hand before building a delivery branch from it.`,
    );
  }

  // `git branch -f` refuses to move a branch that is checked out here or in a
  // linked worktree, so the checked-out case has to go through a merge.
  const advanced = currentBranch() === base
    ? git(['merge', '--ff-only', `origin/${base}`])
    : git(['branch', '-f', base, `origin/${base}`]);

  if (advanced.code !== 0) {
    throw new Error(advanced.stderr.trim() || `Could not fast-forward '${base}' to origin/${base}.`);
  }
  return { fetched: true, advanced: true, aheadOfRemote: false };
}

/**
 * The commits unique to `branch` relative to `base`, oldest first — the same
 * range the combine cherry-picked in, and the same range a PR would show.
 *
 * Uses `merge-base` rather than `base..branch` directly so a base branch that
 * has moved on since the combine does not make unrelated commits appear.
 */
export function readBranch(branch: string, base: string | null): BranchGitInfo {
  if (!branchExists(branch)) {
    return { exists: false, upstream: null, commits: [], filesChanged: 0, aheadOfBase: null };
  }

  const upstreamResult = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', `${branch}@{upstream}`]);
  const upstream = upstreamResult.code === 0 ? upstreamResult.stdout.trim() || null : null;

  let range: string | null = null;
  if (base && refExists(base)) {
    const mergeBase = git(['merge-base', base, branch]);
    if (mergeBase.code === 0 && mergeBase.stdout.trim()) {
      range = `${mergeBase.stdout.trim()}..${branch}`;
    }
  }

  if (!range) {
    return { exists: true, upstream, commits: [], filesChanged: 0, aheadOfBase: null };
  }

  // A unit separator between fields and a record separator between commits, so
  // a subject containing tabs or newlines cannot corrupt the parse.
  const log = git(['log', '--reverse', '--format=%H%x1f%h%x1f%s%x1f%an%x1f%aI%x1e', range]);
  const commits: BranchCommit[] = log.stdout
    .split('\x1e')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [sha, shortSha, subject, author, date] = entry.split('\x1f');
      return {
        sha: sha ?? '',
        shortSha: shortSha ?? '',
        subject: subject ?? '',
        author: author ?? '',
        date: date ?? '',
      };
    });

  const files = git(['diff', '--name-only', range]);
  const filesChanged = files.stdout.split('\n').filter((line) => line.trim()).length;

  return { exists: true, upstream, commits, filesChanged, aheadOfBase: commits.length };
}

/* ------------------------------------------------------- PR description */

/** Caps on what goes into the prompt. A branch combining a dozen tasks can carry
 *  a diff far larger than any useful context window. */
const MAX_LOG_CHARS = 60_000;
const MAX_STAT_CHARS = 20_000;

function truncate(text: string, limit: number, what: string): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n\n[…${what} truncated at ${limit} characters]`;
}

/**
 * Ask the configured agent for a PR title and body.
 *
 * The commit history is gathered here and passed in the prompt rather than left
 * for the agent to fetch. The default command runs `pi --no-tools`, which is
 * what makes this safe to fire from a web request: a tool-enabled agent could
 * block on an approval prompt with nobody at the terminal to answer it, and
 * could touch the working tree while the user is mid-combine. Anything
 * configured in its place wants the equivalent flag. The trade-off is that the
 * agent sees exactly what we send — hence the generous caps above.
 */
export function generatePrDescription(
  branch: string,
  base: string,
): { title: string; body: string; raw: string } {
  const command = ws.config.prAgent;
  if (!command) {
    throw new Error(
      'PR description generation is disabled — set "prAgent" in .tasks/tasks.config.json.',
    );
  }

  const mergeBase = git(['merge-base', base, branch]);
  if (mergeBase.code !== 0 || !mergeBase.stdout.trim()) {
    throw new Error(`Could not find a common ancestor between '${base}' and '${branch}'.`);
  }
  const range = `${mergeBase.stdout.trim()}..${branch}`;

  const log = git(['log', '--reverse', '--format=%h %s%n%b%n---', range]);
  if (log.code !== 0) throw new Error(log.stderr.trim() || `Could not read the log for '${branch}'.`);
  if (!log.stdout.trim()) throw new Error(`'${branch}' has no commits ahead of '${base}'.`);

  const stat = git(['diff', '--stat', range]);

  const prompt = [
    'You are writing a GitHub pull request description.',
    '',
    `The branch is '${branch}', targeting '${base}'.`,
    'Below is the complete commit history unique to this branch, oldest first,',
    'followed by the diffstat. Work only from what is shown — do not invent',
    'changes, ticket numbers, or testing that is not evidenced here.',
    '',
    'Respond with a title line, then a blank line, then the body in Markdown.',
    '',
    'The title MUST use Conventional Commits notation in the form',
    '`type(scope): concise imperative summary`, with no trailing full stop.',
    'Choose the type and scope that best describe the overall change. Use a',
    'conventional type such as `feat`, `fix`, `refactor`, `docs`, `test`, or',
    '`chore`; use a short lowercase scope such as `ui`, `plan`, `quality`,',
    '`pagination`, `frontend`, or the relevant affected area. Do not omit the',
    'scope and do not use a generic title.',
    '',
    'TITLE: <type>(<scope>): <concise imperative summary>',
    '',
    '<body>',
    '',
    'The body should open with a short paragraph on why the change exists, then',
    'a "## What changed" section grouping related commits into bullets by theme',
    'rather than restating every commit. Add a "## Notes for reviewers" section',
    'only when the history genuinely shows something worth flagging. Do not wrap',
    'the response in a code fence.',
    '',
    '=== COMMITS ===',
    truncate(log.stdout.trim(), MAX_LOG_CHARS, 'commit log'),
    '',
    '=== DIFFSTAT ===',
    truncate(stat.stdout.trim(), MAX_STAT_CHARS, 'diffstat'),
  ].join('\n');

  // The prompt is the final argument, so a configured command supplies only
  // its own flags and never has to know where the prompt goes.
  const result = runSync([...command, prompt], AGENT_TIMEOUT_MS);
  const agent = command[0]!;

  if (result.timedOut) {
    throw new Error(
      `${agent} did not finish within ${AGENT_TIMEOUT_MS / 1000}s. Try again, or write the description by hand.`,
    );
  }
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `${agent} exited ${result.code}.`);
  }

  const raw = result.stdout.trim();
  if (!raw) throw new Error(`${agent} returned an empty description.`);

  return { ...splitTitleAndBody(raw), raw };
}

/**
 * Pull the title off the front of the agent's response. The prompt asks for a
 * `TITLE:` line, but a model that ignores that still gives us a usable first
 * line, so fall back to it rather than failing the whole request.
 */
export function splitTitleAndBody(raw: string): { title: string; body: string } {
  const lines = raw.split('\n');
  const index = lines.findIndex((line) => /^TITLE:/i.test(line.trim()));

  if (index !== -1) {
    const title = lines[index]!.replace(/^\s*TITLE:\s*/i, '').trim();
    return { title, body: lines.slice(index + 1).join('\n').trim() };
  }

  const first = lines.findIndex((line) => line.trim());
  if (first === -1) return { title: '', body: '' };

  return {
    // A markdown heading is a title wearing a hat.
    title: lines[first]!.replace(/^#+\s*/, '').trim(),
    body: lines.slice(first + 1).join('\n').trim(),
  };
}

/* -------------------------------------------------------- pull requests */

export interface CreatePrResult {
  url: string;
  number: number | null;
  pushed: boolean;
}

/**
 * Push the branch if it has no upstream yet, then open the PR with `gh`.
 *
 * The body goes to `gh` through a temp file rather than an argument: PR bodies
 * routinely exceed the shell's argument limit, and one containing backticks or
 * `$(...)` has no business being interpolated anywhere.
 */
export async function createPullRequest(input: {
  branch: string;
  base: string;
  title: string;
  body: string;
  draft: boolean;
}): Promise<CreatePrResult> {
  const { branch, base, title, body, draft } = input;

  if (!branchExists(branch)) throw new Error(`Branch '${branch}' does not exist locally.`);
  if (!title.trim()) throw new Error('A pull request needs a title.');

  const existing = runSync(['gh', 'pr', 'view', branch, '--json', 'url', '-q', '.url'], 30_000);
  if (existing.code === 0 && existing.stdout.trim()) {
    throw new Error(`A pull request already exists for '${branch}': ${existing.stdout.trim()}`);
  }

  const hasUpstream =
    git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', `${branch}@{upstream}`]).code === 0;

  let pushed = false;
  if (!hasUpstream) {
    const push = runSync(['git', 'push', '-u', 'origin', branch], GH_TIMEOUT_MS);
    if (push.timedOut) throw new Error(`Pushing '${branch}' timed out.`);
    if (push.code !== 0) throw new Error(push.stderr.trim() || `Could not push '${branch}'.`);
    pushed = true;
  }

  const bodyFile = `${ws.tasksDir}/data/.pr-body-${Date.now()}.md`;
  await Bun.write(bodyFile, body);

  try {
    const args = ['gh', 'pr', 'create', '--head', branch, '--base', base, '--title', title,
      '--body-file', bodyFile];
    if (draft) args.push('--draft');

    const created = runSync(args, GH_TIMEOUT_MS);
    if (created.timedOut) throw new Error('gh pr create timed out.');
    if (created.code !== 0) {
      throw new Error(created.stderr.trim() || created.stdout.trim() || 'gh pr create failed.');
    }

    // gh prints the PR url on stdout, usually as the last line.
    const url = created.stdout.split('\n').map((line) => line.trim())
      .filter((line) => line.startsWith('http')).pop();
    if (!url) throw new Error(`gh did not report a pull request url. Output: ${created.stdout.trim()}`);

    const number = Number(/\/pull\/(\d+)/.exec(url)?.[1]);
    return { url, number: Number.isFinite(number) ? number : null, pushed };
  } finally {
    await Bun.file(bodyFile).delete().catch(() => {});
  }
}

/** Whether the CLIs the Branches view depends on are on PATH. */
export function toolAvailability(): ToolAvailability {
  const agent = ws.config.prAgent?.[0] ?? null;
  const prAgentAvailable = agent !== null && runSync([agent, '--version'], 15_000).code === 0;
  const gh = runSync(['gh', '--version'], 15_000).code === 0;
  const ghAuthed = gh && runSync(['gh', 'auth', 'status'], 15_000).code === 0;
  return { prAgent: agent, prAgentAvailable, gh, ghAuthed };
}
