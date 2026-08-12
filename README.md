# work-task-manager

A development task tracker that lives next to the code, with the visual
before/after evidence for each task attached to it. Work enters it as an
**investigation** — a question written down before anyone goes looking — which an
agent runs to produce tasks.

It wraps the [`aio-vr`](https://github.com/) checkpoint workflow: capture the
state of the UI *before* you change anything, make the change, then capture
*after*. The comparison is stored against the task, so once something is marked
**Dev Complete** you can look at exactly what moved.

The `tasks` command is installed **once, globally**, and behaves according to
whichever repository you run it in — each repo keeps its own `.tasks/` workspace
holding a config file and a SQLite database. This is the same arrangement
`aio-vr` uses with `.aio-vr/`.

```text
work-task-manager/          the tool (this repo, installed globally)
  bin/tasks                 CLI entry point — resolves bun, then runs the CLI
  dist/web/                 built web UI, shipped with the package
  src/
    config/                 workspace discovery + per-repo settings
    shared/                 types shared by the CLI, server and web app
    server/                 bun HTTP API + SQLite + the aio-vr integration
    cli/                    the `tasks` command
    web/                    Vue 3 single-page app

<your-repo>/.tasks/         the workspace (per repository, never committed)
  tasks.config.json         that repo's settings
  data/tasks.db             its tasks, history and checkpoint results

<notes-folder>/             notes: Markdown files, in a Git repo of their own
  <slug>.md                 one note per file, frontmatter + Markdown
  attachments/<slug>/       images and files belonging to that note
```

Notes are the exception to "it lives in the database": see [Notes](#notes).

## Prerequisites

- `bun` — the runtime, the package manager and the SQLite driver
- `aio-vr` on PATH — only needed for the checkpoint commands
- `gh`, and an agent CLI such as `pi` — only needed for the Branches view

## Install

```bash
git clone <this repo> ~/Source/WorkTaskManager
cd ~/Source/WorkTaskManager
bun install
bun run build          # builds the web UI into dist/web
npm link               # or: npm install -g .
tasks help
```

`npm link` symlinks the checkout, so edits to the tool apply immediately and
`tasks web --dev` works. `npm install -g .` copies it instead — fine for use,
but you have to reinstall after every change.

The shim resolves `bun` itself (falling back to `~/.bun/bin/bun`, or `$BUN_BIN`),
so it does not depend on the calling shell having bun on PATH.

## Set up a repository

```bash
cd ~/Source/SomeRepo
tasks init
```

That creates `.tasks/tasks.config.json` and `.tasks/data/`, and adds `.tasks/` to
the clone's `.git/info/exclude` — local to the clone, so the repo's own tracked
ignore rules are untouched. Pass `--track` to skip that and manage it yourself.

The CLI then walks up from the current directory to find `.tasks/`, so every
command works from anywhere inside the repo.

### `tasks.config.json`

Every key has a default, so the file is optional and a partial file is fine. An
unknown key is an error rather than a silent no-op.

| Key | Default | What it does |
|---|---|---|
| `branchPrefix` | `feature/` | Prefix for generated branch names |
| `checkpointPrefix` | `task-` | Prefix for generated aio-vr checkpoint names |
| `baseBranch` | `null` | PR base. `null` resolves it live: `gh repo view`, then `main`/`master` |
| `aioVrDir` | `../.aio-vr` | The aio-vr workspace, resolved relative to `.tasks/` |
| `aioVrBin` | `aio-vr` | The visual-regression executable to drive |
| `notesDir` | `../.notes` | Where notes live, resolved relative to `.tasks/`. Usually a sibling of the repo |
| `notesAutoCommit` | `true` | Commit each notes change as it is made |
| `apiPort` | `5199` | Port `tasks web` serves on |
| `webPort` | `5200` | Port `tasks web --dev` serves Vite on |
| `prAgent` | `["pi","--no-session","-p","--no-tools"]` | Command that writes PR descriptions. `null` disables it |

`prAgent` is a command plus its flags; the prompt is appended as one final
argument. Whatever you configure wants the equivalent of `--no-tools`: the
command is fired from a web request, so a tool-enabled agent could block on an
approval prompt with nobody at the terminal to answer it, and could touch the
working tree while you are mid-combine.

`TASKS_DIR`, `TASKS_DB`, `TASKS_API_PORT`, `TASKS_NOTES_DIR`, `AIO_VR_DIR` and
`AIO_VR_BIN` still override the file for a one-off run.

## The workflow

```text
investigation ──/plan-tasks──▶ tasks
     draft → investigating → complete
```

```text
backlog ──start──▶ in_progress ──done──▶ dev_complete ──verify──▶ verified
                        │                     ▲
                        └──── after-checkpoint capture
```

### Investigations

An investigation is the question, written down before the answering starts: what
is worth looking into, plus whatever you already know about it. It is the first
view in the web UI, above Tasks.

```bash
tasks investigation new "Why is the plan gantt slow on mobile" \
  --brief "It janks while dragging. Start at GanttChart.vue."
```

Then run it with the **`/plan-tasks I-1`** slash command in Claude Code or `pi`.
The agent reads the brief, investigates, files what it finds as tasks carrying
`--investigation I-1`, writes its findings back, and marks the investigation
complete. The detail view then shows the question, the findings, and every task
that came out of it; each task links back to the investigation that filed it.

Writing the brief in the UI rather than typing it into a prompt is the point: it
is kept, it is editable, and the answer lands next to the question rather than
scrolling out of a terminal.

Deleting an investigation keeps the tasks it filed — the work still needs doing —
and simply unlinks them.

```bash
tasks new "Make the plan gantt responsive" --priority high --tag frontend
# Every task receives a branch; create/switch to it before starting.
tasks branch T-1
tasks start T-1

# Capture the current state BEFORE touching anything.
tasks checkpoint before T-1

# ...make the change, re-running `after` as often as you like...
tasks checkpoint after T-1

# Marking it done captures the after-checkpoint for you.
tasks done T-1

# Look at the before/after, then sign off.
tasks web
tasks verify T-1
```

### Why `before` comes first

`after` diffs against a fixed reference captured by `before`, so a task with no
`before` checkpoint has nothing to compare. `tasks done` says so and moves the
task on without a comparison rather than failing.

`after` is idempotent — it always compares against the same reference — so
`edit → after → edit → after` is a supported loop.

### Scenario filters are remembered

If you scope a capture:

```bash
tasks checkpoint before T-1 --scenario login.page
```

then `after` reuses that filter automatically. It has to: aio-vr treats a
scenario present now but absent from the checkpoint as scenario-set drift and
refuses to compare. Pass your own `--scenario`/`--folder` to override.

## CLI

Run `tasks help` for the full list. Every command takes `--json`, which is what
agents should use.

| Command | What it does |
|---|---|
| `tasks init [--dir <path>] [--track]` | Scaffold `.tasks/` in this repository |
| `tasks investigation list [--status s]` | All investigations, unrun first |
| `tasks investigation show <ref>` | The brief, the findings, and the tasks it filed |
| `tasks investigation new "<title>"` | Create one. `--brief` |
| `tasks investigation edit <ref>` | Change `--title`, `--brief`, `--findings`, `--status` |
| `tasks investigation start\|complete <ref>` | Move it along; `complete` takes `--findings` |
| `tasks investigation rm <ref>` | Delete it; the tasks it filed are kept, unlinked |
| `tasks list [--status s] [--tag t]` | All tasks, in list order. `--investigation <ref>` |
| `tasks show <ref>` | One task with its history and checkpoint results |
| `tasks new "<title>"` | Create; assigns a generated branch. `--branch`, `--desc`, `--priority`, `--tag`, `--investigation` |
| `tasks edit <ref>` | Change `--title`, `--desc`, `--priority`, `--status`, `--tag`, `--investigation` |
| `tasks note <ref> <text>` | Append a note to the history |
| `tasks move <ref> --top\|--bottom\|--up\|--down` | Reorder the list |
| `tasks move <ref> --before\|--after <ref>` | Reorder relative to another task |
| `tasks branch <ref>` | Create or switch to the task's assigned branch |
| `tasks start\|done\|verify\|reopen <ref>` | Move through the workflow (`start` requires the assigned branch) |
| `tasks checkpoint before\|after\|status <ref>` | Drive aio-vr |
| `tasks web [--port n] [--dev]` | Serve the UI |
| `tasks rm <ref>` | Delete a task (the checkpoint on disk is left alone) |

`tasks investigation` shortens to `tasks inv`. Its `--brief` and `--findings`
accept `-` to read the text from stdin, which is how an agent gets multi-line
Markdown in without fighting the shell.

### List order

The task list is a manually ordered queue, not a computed ranking. Status and
priority describe a task; they no longer sort it. **The task at the top is the
one `/work-task` picks up when it is given no ref**, so the order is a decision
you make rather than one the tool makes for you.

Reorder by dragging rows in `tasks web` (or `Alt+↑`/`Alt+↓` with a row focused),
or from the CLI with `tasks move`. `tasks list` numbers each row with its place
in that order.

Newly created tasks are **appended**, so filing something mid-session — an agent
recording what it found, or an investigation filing a batch — never jumps the
queue. A batch keeps the order it was filed in. Promote one with
`tasks move <ref> --top`.

Reordering only permutes the positions of the tasks it is handed, so dragging
within a filtered view rearranges those rows and leaves the hidden ones where
they were. Existing databases are backfilled with the ordering the list used
before manual order existed, so nothing appears to move on upgrade.

### Combine task branches (web UI)

A **Verified** task can be closed from its detail view with **Clean checkpoint & close**. This runs `aio-vr clean --name <task-checkpoint>` first; only a successful cleanup marks the task **Closed**. Closed tasks are omitted from the normal list but remain available through an explicit status query/API request.

In `tasks web`, tick two or more **Dev Complete** or **Verified** tasks, enter the
new combined branch name, and select **Combine branches**. The server requires a
clean working tree and creates the combined branch from the branch currently
checked out. It cherry-picks each selected task branch's complete commit range,
in task-list order, producing a normal linear branch. This is intentionally not
a rebase or merge: a cherry-pick-based copy is directly portable to another
repository. Resolve any reported cherry-pick conflict on the newly-created
branch before retrying. **Close tasks** is checked by default. When checked,
every selected task must be Verified; after all cherry-picks succeed, each
checkpoint is cleaned and its task is closed.

### Branches

Every newly created task is assigned a Git-valid branch name, generated as
`<branchPrefix>t-<n>-<title-slug>` unless `--branch` supplies an override. Use
`tasks branch <ref>` to create or switch to it; `tasks start` refuses to begin
work from another branch. Existing `backlog` and `in_progress` tasks are
backfilled when the database is first opened. Historical completed tasks are
left unassigned.

### For agents

```bash
tasks investigation list --json        # what is waiting to be investigated
tasks investigation show I-1 --json    # the brief to work from
tasks list --json                      # the queue, top first
tasks list --status in_progress --json # is something already being worked?
tasks show T-1 --json                  # full detail incl. per-scenario results
tasks notes list --json                # what has been written down
tasks notes show <path> --raw          # the Markdown body, nothing else
tasks checkpoint after T-1 --json      # capture and get the comparison back
tasks done T-1 --json                  # capture + transition in one step
```

Two global slash commands wrap this, installed in both `~/.claude/commands/` and
`~/.pi/agent/prompts/`:

- **`/plan-tasks [I-<n>]`** — runs an investigation that was written down in the
  Investigations view: reads the brief, investigates the codebase, files what it
  finds as tasks linked to that ref, and writes its findings back. Each
  description carries enough detail that the next agent does not have to repeat
  the investigation. It changes no code. With no ref it takes the investigation
  waiting to be run.
- **`/work-task [ref]`** — drives one task through the whole workflow: branch
  from the base branch → `checkpoint before` → make the change →
  `checkpoint after` → `tasks done`. With no ref it takes the task at the top of
  the list. It stops rather than starting a second task when one is already
  `in_progress`.

The natural pairing is `/plan-tasks` to fill the backlog, then `/work-task` to
empty it.

`--json` on a capture suppresses aio-vr's progress output and returns a single
JSON document: the run, its per-scenario comparisons, and the updated task.
`tasks done --json` also carries a `captureError` field — the transition still
happens if the capture fails, so this is how you find out that it did.

## Notes

Notes are the one thing here that is **not** in the database. They are Markdown
files in a folder of their own, and that folder is normally its own Git
repository — so a note can be grepped, edited in vim or Obsidian, diffed, pushed
to a remote and read on another machine without this tool being involved at all.
The file is the record; nothing about it is mirrored into SQLite.

Point `notesDir` at wherever they should live. It resolves relative to `.tasks/`,
so a sibling of the repository is an ordinary value:

```json
{ "notesDir": "../../InspirationNotes" }
```

```bash
tasks notes init    # create the folder and `git init` it
```

`init` is also what the Notes view offers when the configured folder is not there
yet. When the folder ends up *inside* the repo (which the `../.notes` default
does), it is added to that clone's `.git/info/exclude`, the same way `.tasks/` is
— a nested repository has no business showing up in the host repo's status.

### The layout

```text
InspirationNotes/
  .git/
  ideas/gantt-is-slow.md
  attachments/ideas/gantt-is-slow/screenshot.png
```

A note's **path is its identity** — there is no id, so a file renamed by another
editor or arriving from a `git pull` keeps working. The top of each file is
frontmatter (`title`, `tags`, `created`, `updated`); anything else already up
there is preserved on write, so a note that Obsidian has annotated survives a
round trip through this tool.

Attachments are stored per note under `attachments/`, and linked *relatively*
(`../attachments/ideas/gantt-is-slow/screenshot.png`) so the Markdown renders
anywhere. The web app resolves those links through the API, which refuses any
path that escapes the notes folder.

### Git

With `notesAutoCommit` on (the default) every write — save, attach, rename,
delete — is committed as it happens, so the history is Git's rather than
nobody's. A failed commit never loses the edit: the file is written first, and
`tasks notes sync` picks up whatever could not be committed. The Notes view shows
the branch, the uncommitted count and the unpushed count, with **Commit** and
**Push** buttons for a folder that has a remote.

Pushing is the only operation here that talks to a network, and it is never
automatic.

### CLI

```bash
tasks notes list [--tag t] [--folder f] [--search q]
tasks notes show <path> [--raw]        # --raw prints the body alone, for pipes
tasks notes new "<title>" [--folder ideas] [--body -] [--tag t]
tasks notes edit <path> [--title t] [--body -] [--append -] [--rename <path>]
tasks notes open <path>                # $EDITOR on the real file, then commit
tasks notes attach <path> <file>...    # copy files in and link them
tasks notes rm <path>
tasks notes sync [--push]
tasks notes status
```

`--body -` and `--append -` read from stdin, which is how an agent writes a long
note without quoting it. `tasks notes <path>` is shorthand for `show`.

## Web UI

```bash
tasks web           # serves the bundled build on the configured apiPort
tasks web --dev     # Vite dev server on webPort, API on apiPort
```

The rail on the far left switches between **Investigations**, **Tasks**,
**Branches** and **Notes**. Investigations come first because that is where work
starts: write the brief, run `/plan-tasks` against it, and the tasks it produced
appear underneath it.

The Notes screen is a Markdown editor with a live preview (**Write** / **Split** /
**Read**). Images pasted or dropped into the editor are uploaded, stored beside
the note and linked at the caret. Everything it writes goes to the file system,
not the database — the list is re-read each time the view is opened, because the
CLI, an agent or a `git pull` may have changed the folder behind the tab's back.

The task list is on the left; selecting a task shows its description, workflow
buttons, the visual checkpoint section and its history. Rows are dragged to set
the queue order (`Alt+↑`/`Alt+↓` does the same from the keyboard) — see
[List order](#list-order). Each scenario can be
viewed **side by side**, through a drag-to-reveal **slider**, as the computed
**diff**, or as the before/after on their own.

Captures can also be triggered from the UI. They drive a real browser through
every scenario, so they take a while and the request is held open until they
finish.

`--dev` needs this repository's dev dependencies, so it only works from a
checkout (which is what `npm link` gives you). A copied global install serves
the bundled `dist/web` and says so if you ask for `--dev`.

## How it fits together

- **Two roots, deliberately.** The *package* is where the tool is installed —
  the server entry point, the built SPA. The *workspace* is the `.tasks/` folder
  of whichever repo you are in — the config and the database. One package, as
  many workspaces as you have repositories. The web server runs with the package
  as its working directory (that is where its dependencies are), so the CLI
  passes the resolved workspace down in `TASKS_DIR` rather than letting it
  search.
- Checkpoint name is derived from the task ref — `T-1` → `task-t-1`. Nothing to
  wire up by hand and nothing to typo.
- The checkpoint directory on disk stays the source of truth. `before` writes
  `meta.json`, `after` writes `results.json`, and the database records what
  those files said plus which filters produced them.
- Screenshots are **not** copied into the database. Rows store repo-relative
  paths and the server streams the PNGs out of the aio-vr workspace, refusing
  anything that resolves outside it.
- Because artefacts are read from disk, deleting a checkpoint leaves the task's
  history intact but the images stop rendering. `tasks rm` deliberately does not
  touch the aio-vr workspace.
- **Notes go the other way on purpose.** Workflow state — statuses, transitions,
  queue order — is what a database is for. Prose is not: it wants to be a file
  somebody else's tools can open, and a history somebody else's clone can pull.
  So notes are files, their folder is a repository, and this tool is one of
  several ways to write them rather than the only one.
- The Markdown preview is rendered by a small renderer in `src/web/markdown.ts`
  rather than a dependency. It escapes the source before any rule runs, so the
  only markup in the output is the markup it emits — which is what makes it safe
  to preview a note written by an agent or pulled from someone else's clone.

## Caveats

- `aio-vr` rewrites `results.json` in the checkpoint directory on every run,
  including `before`. A failed `after` therefore leaves the *previous* file in
  place; the integration checks `generatedAt` against the time the run started
  and refuses stale results rather than recording a comparison that never
  happened.
- Recordings freeze API data but not the clock, so date-driven UI drifts against
  a fixed checkpoint as real time moves on.
- Each repo's database is local and untracked. It is not shared between
  machines.
