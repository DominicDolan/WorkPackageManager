#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { packageRoot, workspace } from '../config/paths';
import { CONFIG_FILENAME, DEFAULT_CONFIG } from '../config/config';
import { aioVrAvailable, captureAfter, captureBefore, checkpointExists } from '../server/aiovr';
import {
  addNote,
  createInvestigation,
  createTask,
  deleteInvestigation,
  deleteTask,
  getInvestigationDetail,
  getTaskDetail,
  isInvestigationStatus,
  isPriority,
  isStatus,
  latestRun,
  listInvestigations,
  listTasks,
  moveTask,
  requireInvestigation,
  requireTask,
  setInvestigationStatus,
  setStatus,
  updateInvestigation,
  updateTask,
  type MoveTarget,
} from '../server/repo';
import {
  addAttachment,
  commitNotes,
  createNote,
  deleteNote,
  initNotes,
  isNotesRepo,
  listNotes,
  notesDir,
  notesDirExists,
  notesGitInfo,
  normalizeNotePath,
  readNote,
  syncNotes,
  updateNote,
} from '../server/notes';
import {
  INVESTIGATION_STATUS_LABELS,
  INVESTIGATION_STATUSES,
  STATUS_LABELS,
  STATUSES,
  type Comparison,
  type InvestigationStatus,
  type Priority,
  type Status,
  type Task,
} from '../shared/types';

/* --------------------------------------------------------- arg handling */

interface Args {
  positional: string[];
  flags: Record<string, string | boolean | string[]>;
}

/** Flags that may be repeated; their values collect into an array. */
const REPEATABLE = new Set(['scenario', 'folder', 'tag']);

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string | boolean | string[]> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;

    if (!argument.startsWith('--')) {
      positional.push(argument);
      continue;
    }

    const withoutDashes = argument.slice(2);
    const equalsAt = withoutDashes.indexOf('=');

    let key = equalsAt === -1 ? withoutDashes : withoutDashes.slice(0, equalsAt);
    let value: string | boolean;

    if (equalsAt !== -1) {
      value = withoutDashes.slice(equalsAt + 1);
    } else if (key.startsWith('no-')) {
      key = key.slice(3);
      value = false;
    } else {
      const next = argv[index + 1];
      // A bare flag followed by another flag (or nothing) is a boolean.
      if (next === undefined || next.startsWith('--')) {
        value = true;
      } else {
        value = next;
        index += 1;
      }
    }

    if (REPEATABLE.has(key)) {
      const existing = flags[key];
      const list = Array.isArray(existing) ? existing : [];
      list.push(String(value));
      flags[key] = list;
    } else {
      flags[key] = value;
    }
  }

  return { positional, flags };
}

function flagString(args: Args, name: string): string | undefined {
  const value = args.flags[name];
  if (value === undefined || typeof value === 'boolean') return undefined;
  return Array.isArray(value) ? value[0] : value;
}

function flagList(args: Args, name: string): string[] | undefined {
  const value = args.flags[name];
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value;
  if (typeof value === 'boolean') return undefined;
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function flagBool(args: Args, name: string, fallback = false): boolean {
  const value = args.flags[name];
  if (value === undefined) return fallback;
  if (typeof value === 'boolean') return value;
  return value !== 'false' && value !== '0';
}

/* ---------------------------------------------------------------- output */

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;

const paint = (code: string, text: string): string =>
  useColor ? `\u001b[${code}m${text}\u001b[0m` : text;

const dim = (text: string) => paint('2', text);
const bold = (text: string) => paint('1', text);
const red = (text: string) => paint('31', text);
const green = (text: string) => paint('32', text);
const yellow = (text: string) => paint('33', text);
const cyan = (text: string) => paint('36', text);

const STATUS_COLOR: Record<Status, (text: string) => string> = {
  backlog: dim,
  in_progress: cyan,
  dev_complete: yellow,
  verified: green,
  closed: dim,
};

function statusBadge(status: Status): string {
  return STATUS_COLOR[status](STATUS_LABELS[status]);
}

const INVESTIGATION_COLOR: Record<InvestigationStatus, (text: string) => string> = {
  draft: dim,
  investigating: cyan,
  complete: green,
};

function investigationBadge(status: InvestigationStatus): string {
  return INVESTIGATION_COLOR[status](INVESTIGATION_STATUS_LABELS[status]);
}

// Accepts a not-yet-persisted comparison too, so a fresh capture and one read
// back from the database print through the same code.
function comparisonLine(comparison: Omit<Comparison, 'id' | 'runId'>): string {
  const tint =
    comparison.status === 'changed'
      ? yellow
      : comparison.status === 'failed'
        ? red
        : comparison.status === 'unchanged'
          ? green
          : dim;

  const percent =
    comparison.percentChanged === null
      ? ''
      : `  ${comparison.percentChanged.toFixed(2)}%`;

  return `    ${comparison.scenario.padEnd(24)} ${tint(comparison.status.padEnd(12))}${percent}`;
}

function print(text = ''): void {
  console.log(text);
}

function emitJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

/* -------------------------------------------------------------- commands */

function commandList(args: Args): void {
  const status = flagString(args, 'status');
  if (status && !isStatus(status)) {
    throw new Error(`Unknown status '${status}'. Expected one of: ${STATUSES.join(', ')}.`);
  }

  const tasks = listTasks({
    status: status as Status | undefined,
    tag: flagList(args, 'tag')?.[0],
    investigationRef: flagString(args, 'investigation'),
  });

  if (flagBool(args, 'json')) {
    emitJson({ tasks });
    return;
  }

  if (!tasks.length) {
    print(dim('No tasks yet. Create one with `tasks new "<title>"`.'));
    return;
  }

  printTaskLines(tasks);
  print(dim(`  ${tasks.length} task(s), in list order — the top one is next up`));
  print();
}

/** The shared list rendering. The leading number is the row's place in the
 *  manual order, which is what `tasks move` and the web UI rearrange. */
function printTaskLines(tasks: Task[]): void {
  print();
  tasks.forEach((task, index) => {
    const tags = task.tags.length ? dim(`  [${task.tags.join(', ')}]`) : '';
    const priority = task.priority === 'high' ? red('!') : task.priority === 'low' ? dim('.') : ' ';
    const place = dim(String(index + 1).padStart(3));
    print(`${place}  ${bold(task.ref.padEnd(6))} ${priority} ${statusBadge(task.status).padEnd(22)} ${task.title}${tags}`);
  });
  print();
}

const MOVE_USAGE =
  'Usage: tasks move <ref> [--top | --bottom | --up | --down | --before <ref> | --after <ref>]';

function commandMove(args: Args): void {
  const ref = args.positional[1];
  if (!ref) throw new Error(MOVE_USAGE);

  const before = flagString(args, 'before');
  const after = flagString(args, 'after');
  const relative: MoveTarget[] = [];
  if (before) relative.push({ to: 'before', ref: before });
  if (after) relative.push({ to: 'after', ref: after });
  for (const to of ['top', 'bottom', 'up', 'down'] as const) {
    if (flagBool(args, to)) relative.push({ to });
  }

  if (relative.length !== 1) {
    throw new Error(
      relative.length ? `Pick exactly one destination. ${MOVE_USAGE}` : MOVE_USAGE,
    );
  }

  const tasks = moveTask(ref, relative[0]!);

  if (flagBool(args, 'json')) {
    emitJson({ tasks });
    return;
  }

  printTaskLines(tasks);
  print(dim(`  moved ${requireTask(ref).ref}`));
  print();
}

function commandShow(args: Args): void {
  const ref = args.positional[1];
  if (!ref) throw new Error('Usage: tasks show <ref>');

  const detail = getTaskDetail(ref);

  if (flagBool(args, 'json')) {
    emitJson({ task: detail });
    return;
  }

  print();
  print(`  ${bold(detail.ref)}  ${detail.title}`);
  print(`  ${statusBadge(detail.status)}   ${dim(`priority: ${detail.priority}`)}`);
  if (detail.tags.length) print(`  ${dim(`tags: ${detail.tags.join(', ')}`)}`);
  if (detail.description) {
    print();
    for (const line of detail.description.split('\n')) print(`  ${line}`);
  }

  print();
  print(`  ${dim('branch:')} ${detail.branchName ?? '(none — legacy completed task)'}`);
  print(`  ${dim('checkpoint:')} ${detail.checkpointName ?? '(none)'}`);

  for (const run of detail.runs) {
    print();
    print(`  ${bold(run.phase)} ${dim(`#${run.id} — ${run.createdAt}`)}`);
    for (const comparison of run.comparisons) print(comparisonLine(comparison));
  }

  const notes = detail.events.filter((event) => event.type === 'note');
  if (notes.length) {
    print();
    print(`  ${dim('notes')}`);
    for (const note of notes) print(`    ${dim(note.createdAt.slice(0, 16))}  ${note.note}`);
  }

  print();
}

function commandNew(args: Args): void {
  const title = args.positional.slice(1).join(' ');
  if (!title) throw new Error('Usage: tasks new "<title>" [--branch <name>] [--desc <text>] [--priority high]');

  const priority = flagString(args, 'priority');
  if (priority && !isPriority(priority)) {
    throw new Error(`Unknown priority '${priority}'. Expected low, medium or high.`);
  }

  const task = createTask({
    title,
    description: flagString(args, 'desc') ?? flagString(args, 'description'),
    priority: priority as Priority | undefined,
    tags: flagList(args, 'tag'),
    branchName: flagString(args, 'branch'),
    investigationRef: flagString(args, 'investigation'),
  });

  if (flagBool(args, 'json')) {
    emitJson({ task });
    return;
  }

  print(`${green('created')}  ${bold(task.ref)}  ${task.title}`);
  if (task.investigationRef) print(dim(`from investigation ${task.investigationRef}`));
  print(dim(`branch: '${task.branchName}'`));
  print(dim(`checkpoint name will be '${task.checkpointName}'`));
}

function commandEdit(args: Args): void {
  const ref = args.positional[1];
  if (!ref) throw new Error('Usage: tasks edit <ref> [--title x] [--desc x] [--priority x] [--tag x]');

  const priority = flagString(args, 'priority');
  if (priority && !isPriority(priority)) {
    throw new Error(`Unknown priority '${priority}'. Expected low, medium or high.`);
  }

  const status = flagString(args, 'status');
  if (status) {
    if (!isStatus(status)) {
      throw new Error(`Unknown status '${status}'. Expected one of: ${STATUSES.join(', ')}.`);
    }
    setStatus(ref, status);
  }

  // `--no-investigation` parses to false, which is how a link gets removed.
  const investigation = args.flags.investigation;
  const task = updateTask(ref, {
    title: flagString(args, 'title'),
    description: flagString(args, 'desc') ?? flagString(args, 'description'),
    priority: priority as Priority | undefined,
    tags: flagList(args, 'tag'),
    investigationRef: investigation === false ? null : flagString(args, 'investigation'),
  });

  if (flagBool(args, 'json')) {
    emitJson({ task: getTaskDetail(task.ref) });
    return;
  }
  print(`${green('updated')}  ${bold(task.ref)}  ${task.title}  ${statusBadge(task.status)}`);
}

function commandNote(args: Args): void {
  const ref = args.positional[1];
  const note = args.positional.slice(2).join(' ');
  if (!ref || !note) throw new Error('Usage: tasks note <ref> <text>');

  const task = addNote(ref, note);
  if (flagBool(args, 'json')) {
    emitJson({ task: getTaskDetail(task.ref) });
    return;
  }
  print(`${green('noted')}  ${bold(task.ref)}`);
}

function commandRemove(args: Args): void {
  const ref = args.positional[1];
  if (!ref) throw new Error('Usage: tasks rm <ref>');

  const task = requireTask(ref);
  deleteTask(task.ref);
  print(`${green('deleted')}  ${bold(task.ref)}  ${task.title}`);
  print(dim(`The '${task.checkpointName}' checkpoint on disk was left alone.`));
}

/* -------------------------------------------------------- investigations */

const INVESTIGATION_USAGE =
  'Usage: tasks investigation <list|show|new|edit|start|complete|rm> [...]';

/** Read a body of text from a flag, or from stdin when the flag is `-`. An
 *  agent's findings are long and multi-line; piping them in beats quoting. */
async function textFlag(args: Args, name: string): Promise<string | undefined> {
  const value = flagString(args, name);
  if (value === undefined) return undefined;
  if (value !== '-') return value;
  return await Bun.stdin.text();
}

function investigationList(args: Args): void {
  const status = flagString(args, 'status');
  if (status && !isInvestigationStatus(status)) {
    throw new Error(
      `Unknown status '${status}'. Expected one of: ${INVESTIGATION_STATUSES.join(', ')}.`,
    );
  }

  const investigations = listInvestigations({ status: status as InvestigationStatus | undefined });

  if (flagBool(args, 'json')) {
    emitJson({ investigations });
    return;
  }

  if (!investigations.length) {
    print(dim('No investigations yet. Write one with `tasks investigation new "<title>"`.'));
    return;
  }

  print();
  for (const investigation of investigations) {
    const taskCount = listTasks({
      investigationRef: investigation.ref,
      includeClosed: true,
    }).length;
    const tasks = taskCount ? dim(`  ${taskCount} task(s)`) : '';
    print(
      `  ${bold(investigation.ref.padEnd(6))} ${investigationBadge(investigation.status).padEnd(22)} ${investigation.title}${tasks}`,
    );
  }
  print();
  print(dim(`  ${investigations.length} investigation(s)`));
  print();
}

function investigationShow(args: Args): void {
  const ref = args.positional[2];
  if (!ref) throw new Error('Usage: tasks investigation show <ref>');

  const detail = getInvestigationDetail(ref);

  if (flagBool(args, 'json')) {
    emitJson({ investigation: detail });
    return;
  }

  print();
  print(`  ${bold(detail.ref)}  ${detail.title}`);
  print(`  ${investigationBadge(detail.status)}`);

  if (detail.brief) {
    print();
    print(`  ${dim('brief')}`);
    for (const line of detail.brief.split('\n')) print(`  ${line}`);
  }

  if (detail.findings) {
    print();
    print(`  ${dim('findings')}`);
    for (const line of detail.findings.split('\n')) print(`  ${line}`);
  }

  print();
  if (detail.tasks.length) {
    print(`  ${dim('tasks filed')}`);
    for (const task of detail.tasks) {
      print(`    ${bold(task.ref.padEnd(6))} ${statusBadge(task.status).padEnd(22)} ${task.title}`);
    }
  } else {
    print(dim('  No tasks filed from this investigation yet.'));
  }
  print();
}

async function investigationNew(args: Args): Promise<void> {
  const title = args.positional.slice(2).join(' ');
  if (!title) throw new Error('Usage: tasks investigation new "<title>" [--brief <text>]');

  const investigation = createInvestigation({
    title,
    brief: await textFlag(args, 'brief'),
  });

  if (flagBool(args, 'json')) {
    emitJson({ investigation: getInvestigationDetail(investigation.ref) });
    return;
  }

  print(`${green('created')}  ${bold(investigation.ref)}  ${investigation.title}`);
  print(dim(`Write the brief in \`tasks web\`, then run: /plan-tasks ${investigation.ref}`));
}

async function investigationEdit(args: Args): Promise<void> {
  const ref = args.positional[2];
  if (!ref) {
    throw new Error('Usage: tasks investigation edit <ref> [--title <t>] [--brief <text>] [--findings <text>]');
  }

  const status = flagString(args, 'status');
  if (status) {
    if (!isInvestigationStatus(status)) {
      throw new Error(
        `Unknown status '${status}'. Expected one of: ${INVESTIGATION_STATUSES.join(', ')}.`,
      );
    }
    setInvestigationStatus(ref, status);
  }

  const investigation = updateInvestigation(ref, {
    title: flagString(args, 'title'),
    brief: await textFlag(args, 'brief'),
    findings: await textFlag(args, 'findings'),
  });

  if (flagBool(args, 'json')) {
    emitJson({ investigation: getInvestigationDetail(investigation.ref) });
    return;
  }
  print(`${green('updated')}  ${bold(investigation.ref)}  ${investigation.title}  ${investigationBadge(investigation.status)}`);
}

/** start / complete. `complete` is what an agent calls once it has filed the
 *  tasks; `--findings` is the write-up that stops the next reader repeating it. */
async function investigationTransition(args: Args, status: InvestigationStatus): Promise<void> {
  const ref = args.positional[2];
  if (!ref) throw new Error(`Usage: tasks investigation ${args.positional[1]} <ref>`);

  const findings = await textFlag(args, 'findings');
  if (findings !== undefined) updateInvestigation(ref, { findings });
  const investigation = setInvestigationStatus(ref, status);

  if (flagBool(args, 'json')) {
    emitJson({ investigation: getInvestigationDetail(investigation.ref) });
    return;
  }

  const detail = getInvestigationDetail(investigation.ref);
  print(`${green(INVESTIGATION_STATUS_LABELS[status].toLowerCase())}  ${bold(detail.ref)}  ${detail.title}`);
  if (status === 'complete') print(dim(`${detail.tasks.length} task(s) filed from it`));
}

function investigationRemove(args: Args): void {
  const ref = args.positional[2];
  if (!ref) throw new Error('Usage: tasks investigation rm <ref>');

  const investigation = requireInvestigation(ref);
  const filed = getInvestigationDetail(investigation.ref).tasks.length;
  deleteInvestigation(investigation.ref);
  print(`${green('deleted')}  ${bold(investigation.ref)}  ${investigation.title}`);
  if (filed) print(dim(`${filed} task(s) it filed were kept, no longer linked to it.`));
}

async function commandInvestigation(args: Args): Promise<void> {
  switch (args.positional[1]) {
    case 'list':
    case 'ls':
    case undefined:
      return investigationList(args);
    case 'show':
    case 'get':
      return investigationShow(args);
    case 'new':
    case 'add':
    case 'create':
      return investigationNew(args);
    case 'edit':
    case 'update':
      return investigationEdit(args);
    case 'start':
      return investigationTransition(args, 'investigating');
    case 'complete':
    case 'done':
      return investigationTransition(args, 'complete');
    case 'rm':
    case 'delete':
      return investigationRemove(args);
    default:
      throw new Error(`Unknown investigation subcommand '${args.positional[1]}'. ${INVESTIGATION_USAGE}`);
  }
}

/* ---------------------------------------------------------------- notes */

const NOTES_USAGE =
  'Usage: tasks notes <list|show|new|edit|open|attach|rm|sync|status|init> [...]';

function notesList(args: Args): void {
  const notes = listNotes({
    tag: flagList(args, 'tag')?.[0],
    folder: flagString(args, 'folder'),
    search: flagString(args, 'search') ?? args.positional[2],
  });

  if (flagBool(args, 'json')) {
    emitJson({ notes, notesDir: notesDir() });
    return;
  }

  if (!notesDirExists()) {
    print(dim(`No notes folder at ${notesDir()}. Create it with \`tasks notes init\`.`));
    return;
  }

  if (!notes.length) {
    print(dim('No notes yet. Write one with `tasks notes new "<title>"`.'));
    return;
  }

  print();
  for (const note of notes) {
    const tags = note.tags.length ? dim(`  [${note.tags.join(', ')}]`) : '';
    print(`  ${bold(note.title)}${tags}`);
    print(`  ${dim(note.path.padEnd(40))} ${dim(note.updatedAt.slice(0, 16).replace('T', ' '))}`);
    if (note.excerpt) print(`    ${dim(note.excerpt.slice(0, 100))}`);
    print();
  }
  print(dim(`  ${notes.length} note(s) in ${notesDir()}`));
  print();
}

function notesShow(args: Args): void {
  const path = args.positional[2];
  if (!path) throw new Error('Usage: tasks notes show <path> [--raw]');

  const note = readNote(path);

  if (flagBool(args, 'json')) {
    emitJson({ note });
    return;
  }

  // `--raw` prints the body alone, so it pipes into anything without the
  // decoration a human reading at a terminal wants.
  if (flagBool(args, 'raw')) {
    print(note.body);
    return;
  }

  print();
  print(`  ${bold(note.title)}`);
  print(`  ${dim(note.path)}   ${dim(`updated ${note.updatedAt.slice(0, 16).replace('T', ' ')}`)}`);
  if (note.tags.length) print(`  ${dim(`tags: ${note.tags.join(', ')}`)}`);
  print();
  for (const line of note.body.split('\n')) print(`  ${line}`);
  if (note.attachments.length) {
    print();
    print(`  ${dim('attachments')}`);
    for (const attachment of note.attachments) {
      print(`    ${attachment.name}  ${dim(`${Math.ceil(attachment.size / 1024)} KB`)}`);
    }
  }
  print();
}

async function notesNew(args: Args): Promise<void> {
  const title = args.positional.slice(2).join(' ');
  if (!title) throw new Error('Usage: tasks notes new "<title>" [--folder <f>] [--body <text>|-] [--tag <t>]');

  const note = createNote({
    title,
    folder: flagString(args, 'folder'),
    path: flagString(args, 'path'),
    body: await textFlag(args, 'body'),
    tags: flagList(args, 'tag'),
  });

  if (flagBool(args, 'json')) {
    emitJson({ note });
    return;
  }
  print(`${green('created')}  ${bold(note.path)}  ${note.title}`);
  print(dim(`Edit it with: tasks notes open ${note.path}`));
}

async function notesEdit(args: Args): Promise<void> {
  const path = args.positional[2];
  if (!path) {
    throw new Error('Usage: tasks notes edit <path> [--title <t>] [--body <text>|-] [--append <text>|-] [--tag <t>] [--rename <path>]');
  }

  const append = await textFlag(args, 'append');
  const body = await textFlag(args, 'body');
  if (append !== undefined && body !== undefined) {
    throw new Error('Use --body to replace the note or --append to add to it, not both.');
  }

  const current = readNote(path);
  const note = updateNote(path, {
    title: flagString(args, 'title'),
    body:
      append === undefined
        ? body
        : `${current.body.replace(/\s+$/, '')}${current.body.trim() ? '\n\n' : ''}${append.trim()}`,
    tags: flagList(args, 'tag'),
    path: flagString(args, 'rename'),
  });

  if (flagBool(args, 'json')) {
    emitJson({ note });
    return;
  }
  print(`${green('updated')}  ${bold(note.path)}  ${note.title}`);
}

/**
 * Hand the file to $EDITOR and commit whatever comes back.
 *
 * Editing the file directly rather than round-tripping the body through this
 * process is the point: the frontmatter is part of the note, `vim` on the real
 * path gets swap files and undo history in the right place, and nothing is lost
 * if the editor is killed.
 */
async function notesOpen(args: Args): Promise<void> {
  const path = args.positional[2];
  if (!path) throw new Error('Usage: tasks notes open <path>');

  const note = readNote(path);
  const editor = flagString(args, 'editor') ?? process.env.VISUAL ?? process.env.EDITOR;
  if (!editor) throw new Error('No editor set. Export $EDITOR, or pass --editor <command>.');

  const absolute = join(notesDir(), note.path);
  const child = Bun.spawn([...editor.split(' ').filter(Boolean), absolute], {
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  if ((await child.exited) !== 0) throw new Error(`${editor} exited with a non-zero status; nothing was committed.`);

  const committed = commitNotes(`notes: edit ${note.path}`);
  print(`${green('saved')}  ${bold(note.path)}${committed ? dim(`  committed ${committed}`) : ''}`);
}

function notesAttach(args: Args): void {
  const path = args.positional[2];
  const files = args.positional.slice(3);
  if (!path || !files.length) throw new Error('Usage: tasks notes attach <path> <file>... [--no-link]');

  const note = readNote(path);
  const snippets: string[] = [];
  for (const file of files) {
    if (!existsSync(file)) throw new Error(`No such file: ${file}`);
    const { attachment, markdown } = addAttachment(note.path, file, readFileSync(file));
    snippets.push(markdown);
    print(`${green('attached')}  ${attachment.name}  ${dim(attachment.path)}`);
  }

  // Linking it into the body is what makes the attachment visible; --no-link
  // stores the file without touching the prose.
  if (flagBool(args, 'link', true)) {
    const updated = readNote(note.path);
    updateNote(note.path, {
      body: `${updated.body.replace(/\s+$/, '')}${updated.body.trim() ? '\n\n' : ''}${snippets.join('\n')}`,
    });
    print(dim(`linked into ${note.path}`));
  }
}

function notesRemove(args: Args): void {
  const path = args.positional[2];
  if (!path) throw new Error('Usage: tasks notes rm <path> [--keep-attachments]');

  const note = readNote(path);
  deleteNote(note.path, { keepAttachments: flagBool(args, 'keep-attachments') });
  print(`${green('deleted')}  ${bold(note.path)}  ${note.title}`);
}

function notesSync(args: Args): void {
  const result = syncNotes({ push: flagBool(args, 'push'), message: flagString(args, 'message') });

  if (flagBool(args, 'json')) {
    emitJson(result);
    return;
  }

  print(result.committed ? `${green('committed')}  ${result.committed}` : dim('Nothing to commit.'));
  if (result.pushed) print(`${green('pushed')}  ${result.git.upstream ?? ''}`);
}

function notesStatus(args: Args): void {
  const git = notesGitInfo();

  if (flagBool(args, 'json')) {
    emitJson({ dir: notesDir(), exists: notesDirExists(), git, notes: listNotes().length });
    return;
  }

  print();
  print(`  ${dim('folder ')}  ${notesDir()}${notesDirExists() ? '' : red('  (missing)')}`);
  print(`  ${dim('notes  ')}  ${listNotes().length}`);
  if (!git.repo) {
    print(`  ${dim('git    ')}  ${yellow('not a Git repository')} — run \`tasks notes init\``);
  } else {
    print(`  ${dim('git    ')}  ${git.branch ?? '(detached)'}  ${git.dirty ? yellow(`${git.dirty} uncommitted`) : green('clean')}`);
    if (git.lastCommit) print(`  ${dim('last   ')}  ${git.lastCommit.shortSha}  ${git.lastCommit.subject}`);
    if (git.upstream) print(`  ${dim('remote ')}  ${git.upstream}${git.unpushed ? yellow(`  ${git.unpushed} unpushed`) : ''}`);
  }
  print();
}

function notesInit(args: Args): void {
  const result = initNotes();

  if (flagBool(args, 'json')) {
    emitJson(result);
    return;
  }

  print();
  print(`  ${result.created ? green('created') : dim('exists ')}  ${result.dir}`);
  print(`  ${result.repoCreated ? green('git init') : dim('git     ')}  ${isNotesRepo() ? 'repository ready' : 'not a repository'}`);
  if (result.excluded === 'added') print(`  ${green('ignored')}  added to the host repo's .git/info/exclude`);
  print();
  print(dim('  Write the first note with: tasks notes new "<title>"'));
  print();
}

async function commandNotes(args: Args): Promise<void> {
  switch (args.positional[1]) {
    case 'list':
    case 'ls':
    case undefined:
      return notesList(args);
    case 'show':
    case 'cat':
    case 'get':
      return notesShow(args);
    case 'new':
    case 'add':
    case 'create':
      return notesNew(args);
    case 'edit':
    case 'update':
      return notesEdit(args);
    case 'open':
      return notesOpen(args);
    case 'attach':
      return notesAttach(args);
    case 'rm':
    case 'delete':
      return notesRemove(args);
    case 'sync':
      return notesSync(args);
    case 'status':
      return notesStatus(args);
    case 'init':
      return notesInit(args);
    default:
      // A bare path is the common case: `tasks notes ideas/gantt.md` shows it.
      if (args.positional[1]?.includes('/') || args.positional[1]?.endsWith('.md')) {
        return notesShow({ ...args, positional: ['notes', 'show', normalizeNotePath(args.positional[1]!)] });
      }
      throw new Error(`Unknown notes subcommand '${args.positional[1]}'. ${NOTES_USAGE}`);
  }
}

/** The repository `init` should scaffold, preferring the Git root over $PWD so
 *  running it from a subdirectory does not bury the workspace. */
function gitRoot(): string | null {
  const result = Bun.spawnSync(['git', 'rev-parse', '--show-toplevel']);
  return result.exitCode === 0 ? result.stdout.toString().trim() || null : null;
}

/**
 * Keep the workspace out of Git the way aio-vr's is: through `.git/info/exclude`,
 * which is local to the clone and leaves the repo's tracked ignore rules alone.
 * A tool that is not part of the project has no business editing the project's
 * `.gitignore`.
 */
function excludeWorkspace(repoRoot: string): 'added' | 'present' | 'no-git' {
  const gitDir = Bun.spawnSync(['git', 'rev-parse', '--absolute-git-dir'], { cwd: repoRoot });
  if (gitDir.exitCode !== 0) return 'no-git';

  const infoDir = join(gitDir.stdout.toString().trim(), 'info');
  const excludePath = join(infoDir, 'exclude');
  const existing = existsSync(excludePath) ? readFileSync(excludePath, 'utf8') : '';
  if (existing.split('\n').some((line) => line.trim() === '.tasks/')) return 'present';

  mkdirSync(infoDir, { recursive: true });
  const separator = existing && !existing.endsWith('\n') ? '\n' : '';
  const entry = '\n# Local task tracker workspace (work-task-manager) — never committed\n.tasks/\n';
  writeFileSync(excludePath, `${existing}${separator}${entry}`);
  return 'added';
}

function commandInit(args: Args): void {
  const target = flagString(args, 'dir') ?? gitRoot() ?? process.cwd();
  const tasksDir = join(target, '.tasks');
  const configPath = join(tasksDir, CONFIG_FILENAME);

  mkdirSync(join(tasksDir, 'data'), { recursive: true });

  const created = !existsSync(configPath);
  // Written out in full rather than left empty: the defaults are the
  // documentation, and every key is meant to be edited in place.
  if (created) writeFileSync(configPath, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`);

  const excluded = flagBool(args, 'track') ? 'skipped' : excludeWorkspace(target);

  if (flagBool(args, 'json')) {
    emitJson({ tasksDir, configPath, configCreated: created, excluded });
    return;
  }

  print();
  print(`  ${created ? green('created') : dim('exists ')}  ${configPath}`);
  print(`  ${dim('data   ')}  ${join(tasksDir, 'data')}`);
  if (excluded === 'added') print(`  ${green('ignored')}  .tasks/ added to .git/info/exclude`);
  if (excluded === 'no-git') print(`  ${dim('note   ')}  not a Git repository, so nothing was excluded`);
  print();
  print(dim('  Edit the config, then create the first task with: tasks new "<title>"'));
  print();
}

/** Shared reporting for a completed capture. */
function reportRun(
  task: Task,
  result: Awaited<ReturnType<typeof captureBefore>>,
  asJson: boolean,
): void {
  if (asJson) {
    emitJson({ run: result, task: getTaskDetail(task.ref) });
    return;
  }

  print();
  print(`  ${bold(result.phase)} checkpoint ${cyan(result.checkpointName)} — ${result.comparisons.length} scenario(s)`);
  for (const comparison of result.comparisons) print(comparisonLine(comparison));
  print();

  if (result.phase === 'after') {
    const changed = result.comparisons.filter((c) => c.status === 'changed').length;
    print(
      changed
        ? `  ${yellow(`${changed} scenario(s) changed`)} — review them in the web app.`
        : `  ${green('No visual differences from the checkpoint.')}`,
    );
    print();
  }
}

function checkpointOptions(args: Args) {
  const minPercent = flagString(args, 'min-percent');
  return {
    scenarios: flagList(args, 'scenario'),
    folders: flagList(args, 'folder'),
    minPercent: minPercent === undefined ? undefined : Number(minPercent),
    allowMissing: flagBool(args, 'allow-missing'),
    inheritStdio: !flagBool(args, 'json'),
  };
}

async function commandCheckpoint(args: Args): Promise<void> {
  const phase = args.positional[1];
  const ref = args.positional[2];

  if (!phase || !ref) {
    throw new Error('Usage: tasks checkpoint <before|after|status> <ref>');
  }

  const task = requireTask(ref);
  const asJson = flagBool(args, 'json');

  if (phase === 'status') {
    const detail = getTaskDetail(task.ref);
    if (asJson) {
      emitJson({
        ref: task.ref,
        checkpointName: task.checkpointName,
        checkpointExists: checkpointExists(task.checkpointName ?? ''),
        runs: detail.runs,
      });
      return;
    }

    print();
    print(`  ${bold(task.ref)}  checkpoint ${cyan(task.checkpointName ?? '(none)')}`);
    print(
      `  on disk: ${checkpointExists(task.checkpointName ?? '') ? green('yes') : dim('no')}`,
    );
    for (const run of detail.runs) {
      print();
      print(`  ${bold(run.phase)} ${dim(`#${run.id} — ${run.createdAt}`)}`);
      for (const comparison of run.comparisons) print(comparisonLine(comparison));
    }
    print();
    return;
  }

  if (phase !== 'before' && phase !== 'after') {
    throw new Error("Checkpoint phase must be 'before', 'after' or 'status'.");
  }
  requireAssignedBranch(task);

  const result =
    phase === 'before'
      ? await captureBefore(task, checkpointOptions(args))
      : await captureAfter(task, checkpointOptions(args));

  reportRun(task, result, asJson);
}

/** start / done / verify / reopen. `done` also captures the after-checkpoint,
 *  which is the point at which the before/after becomes reviewable. */
function currentBranch(): string | null {
  const result = Bun.spawnSync(['git', 'branch', '--show-current'], { cwd: workspace().repoRoot });
  return result.exitCode === 0 ? result.stdout.toString().trim() || null : null;
}

function requireAssignedBranch(task: Task): void {
  if (!task.branchName) throw new Error(`${task.ref} has no assigned branch (legacy completed task).`);
  const actual = currentBranch();
  if (actual !== task.branchName) {
    throw new Error(`${task.ref} is assigned to '${task.branchName}', but the current branch is '${actual ?? 'detached HEAD'}'. Run: tasks branch ${task.ref}`);
  }
}

function commandBranch(args: Args): void {
  const ref = args.positional[1];
  if (!ref) throw new Error('Usage: tasks branch <ref>');
  const task = requireTask(ref);
  if (!task.branchName) throw new Error(`${task.ref} has no assigned branch (legacy completed task).`);
  const cwd = workspace().repoRoot;
  const exists = Bun.spawnSync(['git', 'show-ref', '--verify', '--quiet', `refs/heads/${task.branchName}`], { cwd }).exitCode === 0;
  const result = Bun.spawnSync(exists ? ['git', 'switch', task.branchName] : ['git', 'switch', '-c', task.branchName], {
    cwd, stdout: 'inherit', stderr: 'inherit',
  });
  if (result.exitCode !== 0) throw new Error(`Could not switch to '${task.branchName}'.`);
  print(`${green('on branch')}  ${task.branchName}`);
}

async function commandTransition(args: Args, status: Status): Promise<void> {
  const ref = args.positional[1];
  if (!ref) throw new Error(`Usage: tasks ${args.positional[0]} <ref>`);

  const task = requireTask(ref);
  if (status === 'in_progress') requireAssignedBranch(task);
  const asJson = flagBool(args, 'json');

  let captureError: string | null = null;

  // Capturing on the way into dev_complete is the whole workflow: the task is
  // only "done" once there is something to look at. Skipped when no `before`
  // was ever taken, since `after` has nothing to compare against.
  if (status === 'dev_complete' && flagBool(args, 'checkpoint', true)) {
    const before = latestRun(task.id, 'before');

    if (before && checkpointExists(task.checkpointName ?? '')) {
      try {
        const result = await captureAfter(task, checkpointOptions(args));
        if (!asJson) reportRun(task, result, false);
      } catch (error) {
        captureError = error instanceof Error ? error.message : String(error);
      }
    } else if (!asJson) {
      print(dim(`No 'before' checkpoint for ${task.ref}; marking done without a comparison.`));
    }
  }

  const updated = setStatus(task.ref, status, flagString(args, 'note'));

  if (asJson) {
    emitJson({ task: getTaskDetail(updated.ref), captureError });
    return;
  }

  print(`${green(STATUS_LABELS[status].toLowerCase())}  ${bold(updated.ref)}  ${updated.title}`);
  if (captureError) print(red(`  after-checkpoint failed: ${captureError}`));
}

/** The dev server and the on-demand build both need the package's own dev
 *  dependencies, which a global install does not ship. */
function requireDevDependencies(what: string): void {
  if (existsSync(join(packageRoot, 'node_modules', 'vite'))) return;
  throw new Error(
    `${what} needs this package's dev dependencies, which a global install does not ship. ` +
      `Run 'bun install' in ${packageRoot}, or reinstall a package built with the SPA bundled.`,
  );
}

async function commandWeb(args: Args): Promise<void> {
  const ws = workspace();
  const dev = flagBool(args, 'dev');
  const apiPort =
    flagString(args, 'port') ?? process.env.TASKS_API_PORT ?? String(ws.config.apiPort);

  // Both children run with the PACKAGE as their cwd, because that is where
  // their dependencies live — which means they cannot find the workspace by
  // walking up from it. TASKS_DIR carries the one this command already resolved.
  const serverPath = join(packageRoot, 'src', 'server', 'index.ts');
  const env = {
    ...process.env,
    TASKS_API_PORT: apiPort,
    TASKS_WEB_PORT: String(ws.config.webPort),
    TASKS_DIR: ws.tasksDir,
  };

  if (dev) {
    requireDevDependencies('tasks web --dev');
    print(dim('Starting the API and the Vite dev server...'));
    const api = Bun.spawn(['bun', 'run', serverPath], { cwd: packageRoot, env, stdout: 'inherit', stderr: 'inherit' });
    const web = Bun.spawn(['bunx', 'vite'], { cwd: packageRoot, env, stdout: 'inherit', stderr: 'inherit' });

    const stop = () => {
      api.kill();
      web.kill();
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);

    await Promise.race([api.exited, web.exited]);
    stop();
    return;
  }

  if (!existsSync(join(ws.distDir, 'index.html'))) {
    requireDevDependencies('Building the web UI');
    print(dim('No build found; building the web UI first...'));
    const build = Bun.spawn(['bunx', 'vite', 'build'], {
      cwd: packageRoot,
      stdout: 'inherit',
      stderr: 'inherit',
    });
    if ((await build.exited) !== 0) throw new Error('The web UI failed to build.');
  }

  const api = Bun.spawn(['bun', 'run', serverPath], {
    cwd: packageRoot,
    env,
    stdout: 'inherit',
    stderr: 'inherit',
  });
  process.on('SIGINT', () => api.kill());
  await api.exited;
}

function commandHelp(): void {
  const ws = (() => {
    try {
      return workspace();
    } catch {
      return null;
    }
  })();

  print(`
${bold('tasks')} — development task tracker with visual before/after evidence

${bold('Setup')}
  tasks init [--dir <path>] [--track]   scaffold .tasks/ in this repository

${bold('Investigations')}   what to look into, before anyone looks
  tasks investigation list [--status draft|investigating|complete] [--json]
  tasks investigation show <ref> [--json]     the brief, the findings, the tasks filed
  tasks investigation new "<title>" [--brief <text>]
  tasks investigation edit <ref> [--title <t>] [--brief <text>] [--findings <text>]
  tasks investigation start <ref>             mark it as being worked on
  tasks investigation complete <ref> [--findings <text>]
  tasks investigation rm <ref>                the tasks it filed are kept
    --brief -  /  --findings -                read the text from stdin instead

  Run one with the ${bold('/plan-tasks')} slash command; it files tasks against the ref.

${bold('Tasks')}
  tasks list [--status <s>] [--tag <t>] [--investigation <ref>] [--json]
  tasks show <ref> [--json]
  tasks new "<title>" [--branch <name>] [--desc <text>] [--priority low|medium|high] [--tag <t>]
                      [--investigation <ref>]
  tasks edit <ref> [--title <t>] [--desc <t>] [--priority <p>] [--status <s>] [--tag <t>]
                   [--investigation <ref> | --no-investigation]
  tasks note <ref> <text>
  tasks rm <ref>

${bold('List order')}   the list is the queue; ${bold('/work-task')} takes the task at the top
  tasks move <ref> --top | --bottom | --up | --down
  tasks move <ref> --before <ref> | --after <ref>
    New tasks are appended, so filing one never jumps the queue.
    Drag the rows in ${bold('tasks web')} to do the same thing by hand.

${bold('Workflow')}   backlog → in_progress → dev_complete → verified
  tasks branch <ref>             create/switch to the task's assigned branch
  tasks start <ref>              move to in_progress (requires assigned branch)
  tasks done <ref>               capture the after-checkpoint, move to dev_complete
                                 (--no-checkpoint to skip the capture)
  tasks verify <ref>             sign off after reviewing the screenshots
  tasks reopen <ref>             back to in_progress

${bold('Visual checkpoints')} (wraps aio-vr)
  tasks checkpoint before <ref>  capture the current state, before you change anything
  tasks checkpoint after <ref>   re-run and diff against it; repeatable
  tasks checkpoint status <ref>  what has been captured so far
    --scenario <name>            limit to a scenario (repeatable)
    --folder <name>              limit to a folder (repeatable)
    --min-percent <n>            'after': treat diffs at or below n% as unchanged
    --allow-missing              'after': warn instead of failing on scenario drift

${bold('Notes')}   Markdown files in their own Git repository, not the database
  tasks notes list [--tag <t>] [--folder <f>] [--search <q>] [--json]
  tasks notes show <path> [--raw] [--json]
  tasks notes new "<title>" [--folder <f>] [--body <text>|-] [--tag <t>]
  tasks notes edit <path> [--title <t>] [--body <text>|-] [--append <text>|-] [--rename <path>]
  tasks notes open <path>        edit the file itself in $EDITOR, then commit it
  tasks notes attach <path> <file>...   copy files in and link them [--no-link]
  tasks notes rm <path>          [--keep-attachments]
  tasks notes sync [--push]      commit anything outstanding
  tasks notes status             where the notes are, and their Git state
  tasks notes init               create the folder and \`git init\` it
    --body -  /  --append -      read the text from stdin instead

${bold('Web UI')}
  tasks web [--port <n>]         serve the UI (port from the repo's config)
  tasks web --dev                hot-reloading dev server (needs a checkout)

${bold('Global')}
  --json                         machine-readable output (for agents)

${dim(`package:   ${packageRoot}`)}
${dim(`workspace: ${ws?.tasksDir ?? '(none found — run `tasks init`)'}`)}
${dim(`config:    ${ws ? join(ws.tasksDir, CONFIG_FILENAME) : '(none)'}`)}
${dim(`database:  ${ws?.dbPath ?? '(none)'}`)}
${dim(`notes:     ${ws ? `${notesDir()}${notesDirExists() ? '' : ' (not created)'}` : '(none)'}`)}
${dim(`aio-vr:    ${ws && aioVrAvailable() ? 'installed' : 'NOT on PATH'}`)}
`);
}

/* ------------------------------------------------------------------ entry */

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const command = args.positional[0] ?? 'help';

  switch (command) {
    case 'init':
      return commandInit(args);
    case 'list':
    case 'ls':
      return commandList(args);
    case 'show':
    case 'get':
      return commandShow(args);
    case 'new':
    case 'add':
    case 'create':
      return commandNew(args);
    case 'edit':
    case 'update':
      return commandEdit(args);
    case 'note':
      return commandNote(args);
    case 'move':
    case 'mv':
      return commandMove(args);
    case 'investigation':
    case 'investigations':
    case 'inv':
      return commandInvestigation(args);
    case 'notes':
    case 'note-file':
      return commandNotes(args);
    case 'rm':
    case 'delete':
      return commandRemove(args);
    case 'branch':
      return commandBranch(args);
    case 'start':
      return commandTransition(args, 'in_progress');
    case 'done':
    case 'complete':
      return commandTransition(args, 'dev_complete');
    case 'verify':
      return commandTransition(args, 'verified');
    case 'reopen':
      return commandTransition(args, 'in_progress');
    case 'checkpoint':
    case 'cp':
      return commandCheckpoint(args);
    case 'web':
    case 'serve':
      return commandWeb(args);
    case 'help':
    case '--help':
    case '-h':
      return commandHelp();
    default:
      throw new Error(`Unknown command '${command}'. Run \`tasks help\`.`);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`${red('error')}  ${message}`);
  process.exit(1);
});
