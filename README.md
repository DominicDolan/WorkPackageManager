# work-task-manager

A development task tracker that lives next to the code, with the visual
before/after evidence for each task attached to it.

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
```

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
| `apiPort` | `5199` | Port `tasks web` serves on |
| `webPort` | `5200` | Port `tasks web --dev` serves Vite on |
| `prAgent` | `["pi","--no-session","-p","--no-tools"]` | Command that writes PR descriptions. `null` disables it |

`prAgent` is a command plus its flags; the prompt is appended as one final
argument. Whatever you configure wants the equivalent of `--no-tools`: the
command is fired from a web request, so a tool-enabled agent could block on an
approval prompt with nobody at the terminal to answer it, and could touch the
working tree while you are mid-combine.

`TASKS_DIR`, `TASKS_DB`, `TASKS_API_PORT`, `AIO_VR_DIR` and `AIO_VR_BIN` still
override the file for a one-off run.

## The workflow

```text
backlog ──start──▶ in_progress ──done──▶ dev_complete ──verify──▶ verified
                        │                     ▲
                        └──── after-checkpoint capture
```

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
| `tasks list [--status s] [--tag t]` | All tasks, most actionable first |
| `tasks show <ref>` | One task with its history and checkpoint results |
| `tasks new "<title>"` | Create; assigns a generated branch. `--branch`, `--desc`, `--priority`, `--tag` |
| `tasks edit <ref>` | Change `--title`, `--desc`, `--priority`, `--status`, `--tag` |
| `tasks note <ref> <text>` | Append a note to the history |
| `tasks branch <ref>` | Create or switch to the task's assigned branch |
| `tasks start\|done\|verify\|reopen <ref>` | Move through the workflow (`start` requires the assigned branch) |
| `tasks checkpoint before\|after\|status <ref>` | Drive aio-vr |
| `tasks web [--port n] [--dev]` | Serve the UI |
| `tasks rm <ref>` | Delete a task (the checkpoint on disk is left alone) |

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
tasks list --json                      # what is in flight
tasks show T-1 --json                  # full detail incl. per-scenario results
tasks checkpoint after T-1 --json      # capture and get the comparison back
tasks done T-1 --json                  # capture + transition in one step
```

Two global Claude Code slash commands wrap this, in `~/.claude/commands/`:

- **`/plan-tasks <what to investigate>`** — investigates the codebase and files
  what it finds as tasks, with enough detail in each description that the next
  agent does not have to repeat the investigation. It changes no code.
- **`/work-task [ref]`** — drives one task through the whole workflow: branch
  from the base branch → `checkpoint before` → make the change →
  `checkpoint after` → `tasks done`. With no ref it picks the first
  `in_progress` or `backlog` task from the ordered list.

The natural pairing is `/plan-tasks` to fill the backlog, then `/work-task` to
empty it.

`--json` on a capture suppresses aio-vr's progress output and returns a single
JSON document: the run, its per-scenario comparisons, and the updated task.
`tasks done --json` also carries a `captureError` field — the transition still
happens if the capture fails, so this is how you find out that it did.

## Web UI

```bash
tasks web           # serves the bundled build on the configured apiPort
tasks web --dev     # Vite dev server on webPort, API on apiPort
```

The task list is on the left; selecting a task shows its description, workflow
buttons, the visual checkpoint section and its history. Each scenario can be
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
