import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { packageRoot } from '../config/paths';
import { resolveArtifact, workspace } from '../config/paths';
import { aioVrAvailable, captureAfter, captureBefore, cleanCheckpoint } from './aiovr';
import {
  addNote,
  createTask,
  deleteTask,
  deleteCombinedBranch,
  findTask,
  getTaskDetail,
  isPriority,
  isStatus,
  listCombinedBranches,
  listTasks,
  recordCombine,
  requireCombinedBranch,
  requireTask,
  recordCombinedBranch,
  updateCombinedBranch,
  updateTask,
  setStatus,
} from './repo';
import {
  createPullRequest,
  defaultBaseBranch,
  generatePrDescription,
  readBranch,
  toolAvailability,
} from './branches';
import {
  PRIORITIES,
  STATUSES,
  type CombinedBranchDetail,
  type Status,
  type Task,
} from '../shared/types';
import { validateBranchName } from './repo';

const ws = workspace();
const port = Number(process.env.TASKS_API_PORT ?? ws.config.apiPort);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function fail(message: string, status = 400): Response {
  return json({ error: message }, status);
}

/** Turn a thrown error into the response the UI expects. `requireTask` is the
 *  only routine that throws a "not found", so it maps to 404. */
function errorResponse(error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error);
  return fail(message, /^No task with ref/.test(message) ? 404 : 400);
}

async function body<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new Error('Request body must be valid JSON.');
  }
}

function parseTags(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error('tags must be an array of strings.');
  return value.map((tag) => String(tag).trim()).filter(Boolean);
}

function git(args: string[]): { code: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(['git', ...args], { cwd: ws.repoRoot });
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

/** Build one linear branch by cherry-picking each selected task branch, in the
 * order chosen. This produces ordinary commits on one branch, precisely the
 * form a cherry-pick-based PR copy can move to another repository. */
async function closeTask(ref: string): Promise<ReturnType<typeof getTaskDetail>> {
  const task = requireTask(ref);
  if (task.status !== 'verified') throw new Error(`${task.ref} must be Verified before it can be closed.`);
  await cleanCheckpoint(task);
  setStatus(task.ref, 'closed', 'Visual checkpoint cleaned and task closed.');
  return getTaskDetail(task.ref);
}

async function combineTasks(refs: string[], requestedBranch: string, closeTasks: boolean): Promise<{ branchName: string; tasks: ReturnType<typeof getTaskDetail>[] }> {
  const branchName = validateBranchName(requestedBranch);
  const uniqueRefs = [...new Set(refs)];
  if (uniqueRefs.length < 2) throw new Error('Select at least two tasks to combine.');
  const tasks = uniqueRefs.map((ref) => getTaskDetail(ref));
  for (const task of tasks) {
    if (!task.branchName) throw new Error(`${task.ref} has no assigned branch.`);
    if (task.status !== 'dev_complete' && task.status !== 'verified') {
      throw new Error(`${task.ref} must be Dev Complete or Verified before it can be combined.`);
    }
    if (closeTasks && task.status !== 'verified') {
      throw new Error(`${task.ref} must be Verified when "Close tasks" is selected.`);
    }
  }

  const current = git(['branch', '--show-current']).stdout.trim();
  if (!current) throw new Error('Cannot combine from a detached HEAD. Switch to the base branch first.');
  if (git(['status', '--porcelain']).stdout.trim()) throw new Error('Working tree must be clean before combining tasks.');
  if (git(['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`]).code === 0) {
    throw new Error(`Branch '${branchName}' already exists.`);
  }

  const create = git(['switch', '-c', branchName]);
  if (create.code !== 0) throw new Error(create.stderr.trim() || `Could not create '${branchName}'.`);
  for (const task of tasks) {
    // Pick the complete, oldest-first commit range unique to this task branch;
    // cherry-picking only its tip would silently omit all earlier task commits.
    const base = git(['merge-base', 'HEAD', task.branchName!]);
    if (base.code !== 0 || !base.stdout.trim()) {
      throw new Error(`Could not find a common ancestor for ${task.ref} (${task.branchName}).`);
    }
    const commits = git(['rev-list', '--reverse', `${base.stdout.trim()}..${task.branchName}`]);
    if (commits.code !== 0 || !commits.stdout.trim()) {
      throw new Error(`${task.ref} (${task.branchName}) has no commits to combine.`);
    }
    for (const commit of commits.stdout.trim().split('\n')) {
      const pick = git(['cherry-pick', commit]);
      if (pick.code !== 0) {
        throw new Error(`Cherry-pick of ${task.ref} (${task.branchName}) conflicted. Resolve it, run 'git cherry-pick --continue', then keep or delete '${branchName}' manually.`);
      }
    }
  }
  for (const task of tasks) recordCombinedBranch(task.ref, branchName);
  // Recorded before the optional close, so the branch is listed in the Branches
  // view even if cleaning a checkpoint fails partway through.
  recordCombine({ branchName, baseBranch: current, taskRefs: tasks.map((task) => task.ref) });
  if (closeTasks) {
    // All Git work succeeded before cleanup starts; a task becomes closed only
    // after aio-vr clean completes successfully for that task.
    for (const task of tasks) await closeTask(task.ref);
  }
  return { branchName, tasks: tasks.map((task) => getTaskDetail(task.ref)) };
}

/* -------------------------------------------------------------- branches */

/** A stored branch plus its live Git state and the tasks it carries. Tasks are
 *  looked up leniently — a combined branch outlives the tasks it was built from,
 *  and a deleted one should not break the view. */
function branchDetail(branchName: string): CombinedBranchDetail {
  const branch = requireCombinedBranch(branchName);
  const base = branch.baseBranch ?? defaultBaseBranch();
  const tasks = branch.taskRefs
    .map((ref) => findTask(ref))
    .filter((task): task is Task => task !== null);

  return { ...branch, git: readBranch(branch.branchName, base), tasks };
}

async function handleBranches(request: Request, rest: string[]): Promise<Response> {
  // Branch names contain slashes, so the name arrives percent-encoded as one
  // segment and everything after it is the action.
  const [rawName, action] = rest;

  if (!rawName) {
    if (request.method !== 'GET') return fail('Method not allowed.', 405);
    return json({
      branches: listCombinedBranches().map((branch) => branchDetail(branch.branchName)),
      defaultBase: defaultBaseBranch(),
    });
  }

  const name = decodeURIComponent(rawName);

  if (!action) {
    if (request.method === 'GET') return json({ branch: branchDetail(name) });

    if (request.method === 'PATCH') {
      const input = await body<{
        baseBranch?: string;
        prTitle?: string;
        prBody?: string;
      }>(request);

      updateCombinedBranch(name, {
        baseBranch: input.baseBranch === undefined ? undefined : validateBranchName(input.baseBranch),
        prTitle: input.prTitle,
        prBody: input.prBody,
      });
      return json({ branch: branchDetail(name) });
    }

    // Forgets the branch here only; the Git branch and any PR are left alone.
    if (request.method === 'DELETE') {
      deleteCombinedBranch(name);
      return json({ deleted: name });
    }

    return fail('Method not allowed.', 405);
  }

  if (request.method !== 'POST') return fail('Method not allowed.', 405);

  // /api/branches/:name/describe — hands the commit history to `pi`.
  if (action === 'describe') {
    const branch = requireCombinedBranch(name);
    const base = branch.baseBranch ?? defaultBaseBranch();
    const { title, body: prBody } = generatePrDescription(branch.branchName, base);

    // Persisted immediately: a generation takes real time and money, and losing
    // it to a closed tab would be the worst possible failure here.
    updateCombinedBranch(name, { prTitle: title, prBody, baseBranch: base });
    return json({ branch: branchDetail(name) });
  }

  // /api/branches/:name/pr — pushes if needed, then opens the PR with `gh`.
  if (action === 'pr') {
    const input = await body<{ draft?: boolean }>(request).catch(() => ({}) as { draft?: boolean });
    const branch = requireCombinedBranch(name);

    if (branch.prUrl) throw new Error(`A pull request was already opened: ${branch.prUrl}`);
    if (!branch.prTitle?.trim()) {
      throw new Error('Generate or write a description before opening the pull request.');
    }

    const result = await createPullRequest({
      branch: branch.branchName,
      base: branch.baseBranch ?? defaultBaseBranch(),
      title: branch.prTitle,
      body: branch.prBody ?? '',
      draft: input.draft ?? false,
    });

    updateCombinedBranch(name, { prUrl: result.url, prNumber: result.number });
    for (const ref of branch.taskRefs) {
      if (findTask(ref)) addNote(ref, `Pull request opened: ${result.url}`);
    }
    return json({ branch: branchDetail(name), pushed: result.pushed });
  }

  return fail('Unknown endpoint.', 404);
}

/* ----------------------------------------------------------------- routes */

async function handleApi(request: Request, url: URL): Promise<Response> {
  const segments = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean);
  const [head, ...rest] = segments;

  if (head === 'meta') {
    return json({
      statuses: STATUSES,
      priorities: PRIORITIES,
      repoRoot: ws.repoRoot,
      aioVrDir: ws.aioVrDir,
      aioVrInstalled: aioVrAvailable(),
      aioVrWorkspaceExists: existsSync(ws.aioVrDir),
      tools: toolAvailability(),
    });
  }

  if (head === 'branches') return handleBranches(request, rest);

  // Screenshots are streamed from disk rather than copied into the database.
  if (head === 'image') {
    const relativePath = url.searchParams.get('path');
    if (!relativePath) return fail('An image path is required.');

    const absolute = resolveArtifact(relativePath);
    if (!absolute) return fail('No such image inside the aio-vr workspace.', 404);

    return new Response(Bun.file(absolute), {
      headers: {
        // Checkpoint artefacts are rewritten in place by each `after` run, so
        // they must never be cached by the browser.
        'cache-control': 'no-store',
      },
    });
  }

  if (head !== 'tasks') return fail('Unknown endpoint.', 404);

  // /api/tasks
  if (rest.length === 0) {
    if (request.method === 'GET') {
      const status = url.searchParams.get('status') ?? undefined;
      if (status && !isStatus(status)) return fail(`Unknown status '${status}'.`);

      return json({
        tasks: listTasks({
          status: status as Status | undefined,
          tag: url.searchParams.get('tag') ?? undefined,
        }),
      });
    }

    if (request.method === 'POST') {
      const input = await body<{
        title?: string;
        description?: string;
        priority?: string;
        tags?: unknown;
        branchName?: string;
      }>(request);

      if (!input.title) return fail('A task needs a title.');
      if (input.priority && !isPriority(input.priority)) {
        return fail(`Unknown priority '${input.priority}'.`);
      }

      return json(
        {
          task: createTask({
            title: input.title,
            description: input.description,
            priority: input.priority as never,
            tags: parseTags(input.tags),
            branchName: input.branchName,
          }),
        },
        201,
      );
    }

    return fail('Method not allowed.', 405);
  }

  if (rest[0] === 'combine') {
    if (request.method !== 'POST') return fail('Method not allowed.', 405);
    const input = await body<{ refs?: unknown; branchName?: unknown; closeTasks?: unknown }>(request);
    if (!Array.isArray(input.refs) || !input.refs.every((ref) => typeof ref === 'string')) {
      return fail('refs must be an array of task references.');
    }
    if (typeof input.branchName !== 'string') return fail('A branch name is required.');
    if (input.closeTasks !== undefined && typeof input.closeTasks !== 'boolean') {
      return fail('closeTasks must be a boolean.');
    }
    const result = await combineTasks(input.refs, input.branchName, input.closeTasks ?? true);
    return json({ branchName: result.branchName, tasks: result.tasks }, 201);
  }

  const [ref, action, phase] = rest;

  // /api/tasks/:ref
  if (action === 'close') {
    if (request.method !== 'POST') return fail('Method not allowed.', 405);
    return json({ task: await closeTask(ref!) });
  }
  if (!action) {
    if (request.method === 'GET') return json({ task: getTaskDetail(ref!) });

    if (request.method === 'PATCH') {
      const input = await body<{
        title?: string;
        description?: string;
        priority?: string;
        tags?: unknown;
      }>(request);

      if (input.priority && !isPriority(input.priority)) {
        return fail(`Unknown priority '${input.priority}'.`);
      }

      updateTask(ref!, {
        title: input.title,
        description: input.description,
        priority: input.priority as never,
        tags: parseTags(input.tags),
      });
      return json({ task: getTaskDetail(ref!) });
    }

    if (request.method === 'DELETE') {
      deleteTask(ref!);
      return json({ deleted: ref });
    }

    return fail('Method not allowed.', 405);
  }

  if (request.method !== 'POST') return fail('Method not allowed.', 405);

  // /api/tasks/:ref/status
  if (action === 'status') {
    const input = await body<{ status?: string; note?: string }>(request);
    if (!input.status || !isStatus(input.status)) {
      return fail(`status must be one of: ${STATUSES.join(', ')}.`);
    }

    setStatus(ref!, input.status, input.note);
    return json({ task: getTaskDetail(ref!) });
  }

  // /api/tasks/:ref/notes
  if (action === 'notes') {
    const input = await body<{ note?: string }>(request);
    if (!input.note) return fail('A note is required.');

    addNote(ref!, input.note);
    return json({ task: getTaskDetail(ref!) });
  }

  // /api/tasks/:ref/checkpoint/:phase
  if (action === 'checkpoint') {
    if (phase !== 'before' && phase !== 'after') {
      return fail("Checkpoint phase must be 'before' or 'after'.");
    }

    const input = await body<{
      scenarios?: string[];
      folders?: string[];
      minPercent?: number;
      allowMissing?: boolean;
    }>(request).catch(() => ({}) as Record<string, never>);

    const task = requireTask(ref!);
    const options = {
      scenarios: input.scenarios,
      folders: input.folders,
      minPercent: input.minPercent,
      allowMissing: input.allowMissing,
      inheritStdio: false,
    };

    const result = phase === 'before'
      ? await captureBefore(task, options)
      : await captureAfter(task, options);

    return json({ run: result, task: getTaskDetail(ref!) });
  }

  return fail('Unknown endpoint.', 404);
}

/* ----------------------------------------------------------------- static */

const indexPath = join(ws.distDir, 'index.html');

function serveStatic(url: URL): Response {
  if (!existsSync(indexPath)) {
    return new Response(
      'The web UI has not been built yet.\n\nRun `bun run build` in the ' +
        'work-task-manager checkout, or use `tasks web --dev` for the ' +
        'hot-reloading dev server.',
      { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } },
    );
  }

  // Serve the requested asset when it exists, otherwise fall back to index.html
  // so client-side routes survive a refresh.
  const candidate = join(ws.distDir, url.pathname);
  if (candidate.startsWith(ws.distDir) && url.pathname !== '/' && existsSync(candidate)) {
    return new Response(Bun.file(candidate));
  }

  return new Response(Bun.file(indexPath), {
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

const server = Bun.serve({
  port,
  // Checkpoint captures drive a real browser through every scenario, which
  // comfortably outlives the default request timeout.
  idleTimeout: 240,
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api')) {
      try {
        return await handleApi(request, url);
      } catch (error) {
        return errorResponse(error);
      }
    }

    return serveStatic(url);
  },
});

console.log(`tasks api  → http://localhost:${server.port}`);
console.log(`repo root  → ${ws.repoRoot}`);
console.log(`database   → ${ws.dbPath}`);
console.log(`workspace  → ${ws.tasksDir}`);
if (!existsSync(indexPath)) {
  console.log(`web ui     → not built (run \`bun run build\` in ${packageRoot})`);
}
