import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import { notesDir, notesDirExists, resolveInNotes } from './notes';
import type { IssueDetail, IssueLabel, IssuePerson, IssueState, IssueSummary } from '../shared/types';

/**
 * Issues, read out of the JSON files sitting in the notes folder.
 *
 * Nothing here fetches anything. Whatever pulled these files down — `gh issue
 * view --json`, a script, an agent — is somebody else's business; this module's
 * whole job is to recognise a file it understands and flatten it into one shape
 * the UI can render. That is what keeps the view provider-agnostic: GitHub today,
 * Azure DevOps when those files start appearing, and both in the same list.
 *
 * The shape is deliberately the *lowest common denominator* — a key, a title, a
 * state, some people and some labels. Anything a provider says beyond that
 * survives in `raw` and is shown on the detail view rather than being forced
 * into a field that only fits one of them.
 */

/* ---------------------------------------------------------------- helpers */

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const text = (value: unknown): string | null => {
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number') return String(value);
  return null;
};

/** States every provider spells differently, reduced to the two that matter for
 *  filtering. The provider's own wording is kept alongside as `stateLabel`. */
const CLOSED_STATES = new Set(['closed', 'done', 'completed', 'removed', 'resolved', 'abandoned']);

function normalizeState(raw: string | null): IssueState {
  return raw && CLOSED_STATES.has(raw.toLowerCase()) ? 'closed' : 'open';
}

/** Markdown or HTML down to a line of prose, for the card. */
function excerptOf(body: string): string {
  const flat = body
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#*_`>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > 220 ? `${flat.slice(0, 217)}…` : flat;
}

/* ----------------------------------------------------------- github */

function githubPerson(value: unknown): IssuePerson | null {
  const person = record(value);
  const name = person && (text(person.login) ?? text(person.name));
  if (!name) return null;
  return {
    name,
    avatarUrl: person ? text(person.avatar_url) : null,
    url: person ? text(person.html_url) : null,
  };
}

function githubLabels(value: unknown): IssueLabel[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry): IssueLabel | null => {
      if (typeof entry === 'string') return { name: entry, color: null, description: null };
      const label = record(entry);
      const name = label && text(label.name);
      if (!name) return null;
      // GitHub gives six hex digits with no `#`. Anything that is not a hex
      // colour is dropped rather than passed through to a style binding.
      const color = label && text(label.color);
      return {
        name,
        color: color && /^#?[0-9a-f]{3,8}$/i.test(color) ? `#${color.replace(/^#/, '')}` : null,
        description: label ? text(label.description) : null,
      };
    })
    .filter((label): label is IssueLabel => label !== null);
}

function looksLikeGithubIssue(value: Record<string, unknown>): boolean {
  const url = text(value.html_url) ?? text(value.url) ?? '';
  return (
    (typeof value.number === 'number' && typeof value.title === 'string' && 'state' in value) ||
    /github\.com/.test(url)
  );
}

/** `https://github.com/Arcadis/Foundry/issues/677` → `Arcadis/Foundry`. */
function githubContainer(issue: Record<string, unknown>): string | null {
  const repository = record(issue.repository);
  if (repository) {
    const full = text(repository.full_name);
    if (full) return full;
  }
  // `repository_url` is the API form (…/repos/owner/repo); `html_url` is the
  // browser one (…/owner/repo/issues/677). Anchored on the segment *after* the
  // marker, so `api.github.com/repos/…` cannot match as `repos/owner`.
  const apiUrl = text(issue.repository_url);
  const fromApi = apiUrl && /\/repos\/([^/]+\/[^/]+)/.exec(apiUrl);
  if (fromApi) return fromApi[1]!;

  const htmlUrl = text(issue.html_url);
  const fromHtml = htmlUrl && /^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/(?:issues|pull)\//.exec(htmlUrl);
  return fromHtml ? fromHtml[1]! : null;
}

function fromGithub(issue: Record<string, unknown>, envelope: Record<string, unknown> | null): Partial<IssueDetail> & { body: string } {
  const state = text(issue.state);
  const type = record(issue.type);
  const body = typeof issue.body === 'string' ? issue.body : '';
  const number = text(issue.number);

  return {
    source: 'github',
    key: number ? `#${number}` : (text(issue.id) ?? '?'),
    title: text(issue.title) ?? '(untitled)',
    state: normalizeState(state),
    stateLabel: text(issue.state_reason) ?? state ?? 'open',
    url: text(issue.html_url),
    container: githubContainer(issue),
    // GitHub's issue *types* are newer than its labels; fall back to the
    // conventional `bug` / `enhancement` label when a repo does not use them.
    kind:
      (type && text(type.name)) ??
      githubLabels(issue.labels).find((label) => /^(bug|enhancement|feature|task)$/i.test(label.name))?.name ??
      null,
    labels: githubLabels(issue.labels),
    author: githubPerson(issue.user),
    assignees: (Array.isArray(issue.assignees) ? issue.assignees : [])
      .map(githubPerson)
      .filter((person): person is IssuePerson => person !== null),
    createdAt: text(issue.created_at),
    updatedAt: text(issue.updated_at),
    closedAt: text(issue.closed_at),
    commentCount: typeof issue.comments === 'number' ? issue.comments : null,
    milestone: text(record(issue.milestone)?.title),
    fetchedAt: envelope ? text(envelope.fetchedAt) : null,
    bodyFormat: 'markdown',
    body,
  };
}

/* ------------------------------------------------------- azure devops */

/**
 * Azure DevOps work items, for when those files start appearing.
 *
 * A work item is a flat `fields` bag keyed by namespaced strings, so the mapping
 * is a lookup table rather than a shape. Written from the REST API's documented
 * field names; the parts that are guesswork about *your* process (which states
 * count as closed, which fields you use) all funnel through the same
 * `normalizeState` and `raw` passthrough the GitHub side uses, so an unexpected
 * value shows up on the card rather than being dropped.
 */
function looksLikeWorkItem(value: Record<string, unknown>): boolean {
  const fields = record(value.fields);
  if (!fields) return false;
  return Object.keys(fields).some((key) => key.startsWith('System.'));
}

function devopsPerson(value: unknown): IssuePerson | null {
  const person = record(value);
  if (!person) return typeof value === 'string' ? { name: value, avatarUrl: null, url: null } : null;
  const name = text(person.displayName) ?? text(person.uniqueName);
  if (!name) return null;
  return { name, avatarUrl: text(person.imageUrl), url: null };
}

function fromDevops(item: Record<string, unknown>, envelope: Record<string, unknown> | null): Partial<IssueDetail> & { body: string } {
  const fields = record(item.fields) ?? {};
  const state = text(fields['System.State']);
  const id = text(item.id) ?? text(fields['System.Id']);

  // `_links.html.href` is the browser URL; `url` is the API one, which is no use
  // to anybody clicking it.
  const links = record(item._links);
  const html = links ? record(links.html) : null;

  const tags = text(fields['System.Tags']);
  const description =
    text(fields['System.Description']) ??
    text(fields['Microsoft.VSTS.TCM.ReproSteps']) ??
    '';

  return {
    source: 'azure-devops',
    key: id ? `#${id}` : '?',
    title: text(fields['System.Title']) ?? '(untitled)',
    state: normalizeState(state),
    stateLabel: state ?? 'New',
    url: html ? text(html.href) : text(item.url),
    container: text(fields['System.TeamProject']) ?? text(fields['System.AreaPath']),
    kind: text(fields['System.WorkItemType']),
    // Tags are one semicolon-separated string; Azure DevOps does not colour them.
    labels: (tags ?? '')
      .split(';')
      .map((tag) => tag.trim())
      .filter(Boolean)
      .map((name) => ({ name, color: null, description: null })),
    author: devopsPerson(fields['System.CreatedBy']),
    assignees: [devopsPerson(fields['System.AssignedTo'])].filter(
      (person): person is IssuePerson => person !== null,
    ),
    createdAt: text(fields['System.CreatedDate']),
    updatedAt: text(fields['System.ChangedDate']),
    closedAt: text(fields['Microsoft.VSTS.Common.ClosedDate']),
    commentCount: typeof fields['System.CommentCount'] === 'number' ? (fields['System.CommentCount'] as number) : null,
    milestone: text(fields['System.IterationPath']),
    fetchedAt: envelope ? text(envelope.fetchedAt) : null,
    // Work item descriptions come back as HTML, not Markdown.
    bodyFormat: 'html',
    body: description,
  };
}

/* ------------------------------------------------------------- parsing */

/**
 * One parsed JSON document, unwrapped into the issue objects it holds.
 *
 * Files come in more than one shape and always will: a single issue, the
 * `{ source, fetchedAt, issue }` envelope the current files use, an array from a
 * bulk export, or Azure DevOps' `{ count, value: [...] }`. Unwrapping here means
 * the adapters only ever see one work item.
 */
function unwrap(document: unknown): { issue: Record<string, unknown>; envelope: Record<string, unknown> | null }[] {
  if (Array.isArray(document)) {
    return document.flatMap((entry) => unwrap(entry));
  }

  const root = record(document);
  if (!root) return [];

  for (const key of ['issue', 'workItem', 'work_item'] as const) {
    const nested = record(root[key]);
    if (nested) return [{ issue: nested, envelope: root }];
  }

  for (const key of ['issues', 'workItems', 'value', 'items'] as const) {
    const list = root[key];
    if (Array.isArray(list)) {
      return list
        .map((entry) => record(entry))
        .filter((entry): entry is Record<string, unknown> => entry !== null)
        .map((entry) => ({ issue: entry, envelope: root }));
    }
  }

  return [{ issue: root, envelope: null }];
}

/**
 * Pick the adapter for one issue object.
 *
 * The envelope's own `source` wins when it has one — that is the field the
 * fetchers write and the only declaration we get — and sniffing the object is
 * the fallback for a file that is just the provider's raw response.
 */
function adapt(
  issue: Record<string, unknown>,
  envelope: Record<string, unknown> | null,
): (Partial<IssueDetail> & { body: string }) | null {
  const declared = envelope ? text(envelope.source)?.toLowerCase().replace(/[\s_]+/g, '-') : null;

  if (declared === 'github') return fromGithub(issue, envelope);
  if (declared && /^(azure-devops|azuredevops|ado|azure|vsts|tfs)$/.test(declared)) {
    return fromDevops(issue, envelope);
  }

  if (looksLikeWorkItem(issue)) return fromDevops(issue, envelope);
  if (looksLikeGithubIssue(issue)) return fromGithub(issue, envelope);
  return null;
}

/** Fill the gaps an adapter left, so every card has the same fields. */
function complete(
  path: string,
  index: number,
  total: number,
  partial: Partial<IssueDetail> & { body: string },
  raw: unknown,
): IssueDetail {
  return {
    // One file usually holds one issue; when it holds several, the index is what
    // keeps their identities distinct.
    id: total > 1 ? `${path}#${index}` : path,
    path,
    source: partial.source ?? 'unknown',
    key: partial.key ?? '?',
    title: partial.title ?? '(untitled)',
    state: partial.state ?? 'open',
    stateLabel: partial.stateLabel ?? 'open',
    url: partial.url ?? null,
    container: partial.container ?? null,
    kind: partial.kind ?? null,
    labels: partial.labels ?? [],
    author: partial.author ?? null,
    assignees: partial.assignees ?? [],
    createdAt: partial.createdAt ?? null,
    updatedAt: partial.updatedAt ?? null,
    closedAt: partial.closedAt ?? null,
    commentCount: partial.commentCount ?? null,
    milestone: partial.milestone ?? null,
    fetchedAt: partial.fetchedAt ?? null,
    excerpt: excerptOf(partial.body),
    bodyFormat: partial.bodyFormat ?? 'markdown',
    body: partial.body,
    raw,
  };
}

/* ------------------------------------------------------------ scanning */

/** Every `.json` file in the notes folder, attachments and dot-directories
 *  aside — the same walk the notes list does, looking for the other extension. */
function jsonFiles(): string[] {
  if (!notesDirExists()) return [];
  const root = notesDir();
  const found: string[] = [];

  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const absolute = join(directory, entry.name);
      const path = relative(root, absolute).split(sep).join('/');

      if (entry.isDirectory()) {
        if (path === 'attachments') continue;
        walk(absolute);
        continue;
      }
      if (entry.isFile() && extname(entry.name).toLowerCase() === '.json') found.push(path);
    }
  };

  walk(root);
  return found.sort();
}

/** Read one file and return the issues in it. A file that is not an issue file
 *  — or is not valid JSON — yields nothing rather than an error: the notes
 *  folder is allowed to contain other JSON. */
function readFile(path: string): IssueDetail[] {
  const absolute = resolveInNotes(path);
  if (!absolute || !existsSync(absolute) || !statSync(absolute).isFile()) return [];

  let document: unknown;
  try {
    document = JSON.parse(readFileSync(absolute, 'utf8'));
  } catch {
    return [];
  }

  const unwrapped = unwrap(document);
  return unwrapped
    .map((entry, index) => {
      const adapted = adapt(entry.issue, entry.envelope);
      return adapted ? complete(path, index, unwrapped.length, adapted, entry.issue) : null;
    })
    .filter((issue): issue is IssueDetail => issue !== null);
}

export interface IssueQuery {
  state?: IssueState | 'all';
  source?: string;
  label?: string;
  search?: string;
}

export function listIssues(query: IssueQuery = {}): IssueSummary[] {
  const issues = jsonFiles().flatMap(readFile);
  const search = query.search?.trim().toLowerCase();

  return issues
    .filter((issue) => (query.state && query.state !== 'all' ? issue.state === query.state : true))
    .filter((issue) => (query.source ? issue.source === query.source : true))
    .filter((issue) => (query.label ? issue.labels.some((label) => label.name === query.label) : true))
    .filter((issue) =>
      search
        ? `${issue.key} ${issue.title} ${issue.excerpt} ${issue.container ?? ''}`.toLowerCase().includes(search)
        : true,
    )
    .map(({ body: _body, raw: _raw, ...summary }) => summary)
    .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
}

/** One issue, with its body and the provider's untouched JSON. `id` is the file
 *  path, or `path#index` for a file holding several. */
export function readIssue(id: string): IssueDetail {
  const [path, index] = id.split('#');
  const issues = readFile(path ?? '');
  const issue = index === undefined ? issues[0] : issues[Number(index)];
  if (!issue) throw new Error(`No issue at '${id}'.`);
  return issue;
}

/**
 * Find one issue from whatever the user typed.
 *
 * The web UI always has an exact id to hand; a person at a terminal has the
 * number they were just talking about. So `677`, `#677`, the file name and the
 * full id all resolve, and an ambiguous reference lists the candidates rather
 * than picking one — guessing which issue somebody meant is the one failure
 * that would quietly send an agent off to plan the wrong work.
 */
export function findIssue(reference: string): IssueDetail {
  const needle = reference.trim();
  if (!needle) throw new Error('An issue reference is required.');

  const all = jsonFiles().flatMap(readFile);
  const key = needle.startsWith('#') ? needle : `#${needle}`;

  const exact = all.filter(
    (issue) => issue.id === needle || issue.path === needle || issue.key === key || issue.key === needle,
  );
  if (exact.length === 1) return exact[0]!;
  if (exact.length > 1) throw ambiguous(needle, exact);

  const lowered = needle.toLowerCase();
  const partial = all.filter(
    (issue) =>
      issue.path.toLowerCase().includes(lowered) || issue.title.toLowerCase().includes(lowered),
  );
  if (partial.length === 1) return partial[0]!;
  if (partial.length > 1) throw ambiguous(needle, partial);

  throw new Error(
    `No issue matching '${needle}'. Run \`tasks issues list\` to see what has been fetched into ${notesDir()}.`,
  );
}

function ambiguous(reference: string, candidates: IssueDetail[]): Error {
  const lines = candidates.slice(0, 8).map((issue) => `  ${issue.id}  ${issue.key}  ${issue.title}`);
  return new Error(
    `'${reference}' matches ${candidates.length} issues:\n${lines.join('\n')}\nUse the id from the first column.`,
  );
}

/** What the filters offer, counted from what is actually there. */
export function issueFacets(): { sources: { source: string; count: number }[]; labels: string[]; total: number } {
  const issues = jsonFiles().flatMap(readFile);
  const sources = new Map<string, number>();
  const labels = new Set<string>();

  for (const issue of issues) {
    sources.set(issue.source, (sources.get(issue.source) ?? 0) + 1);
    for (const label of issue.labels) labels.add(label.name);
  }

  return {
    sources: [...sources.entries()].map(([source, count]) => ({ source, count })).sort((a, b) => b.count - a.count),
    labels: [...labels].sort(),
    total: issues.length,
  };
}
