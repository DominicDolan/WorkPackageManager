# work-task-manager

A development task tracker that lives next to the code, with the visual
before/after evidence for each task attached to it. Work enters it as an
**investigation** — a question written down before anyone goes looking — which an
agent runs to produce tasks.

It wraps the [`aio-vr`](https://github.com/) checkpoint workflow: capture the
state of the UI _before_ you change anything, make the change, then capture
_after_. The comparison is stored against the task, so once something is marked
**Dev Complete** you can look at exactly what moved.

The `tasks` command is installed **once, globally**, and behaves according to
whichever repository you run it in — each repo keeps its own `.tasks/` workspace
holding a config file and a SQLite database. This is the same arrangement
`aio-vr` uses with `.aio-vr/`.

```text
work-task-manager/          the tool (this repo, a Bun workspace monorepo)
  bin/tasks                 symlink to packages/cli/bin/tasks
  packages/
    shared/                 @work-task-manager/shared — API types + pure helpers,
                            safe in a browser
    core/                   @work-task-manager/core — workspace discovery, config,
                            SQLite, Git, checks, agents, notes; prompts/
    server/                 @work-task-manager/server — the HTTP API, plus hosting
                            for whichever UI is configured
    client/                 @work-task-manager/client — typed, framework-agnostic
                            API client; what any UI is built on
    web/                    @work-task-manager/web — the default Solid 2.0 UI
    cli/                    work-task-manager — the `tasks` command
  examples/minimal-ui/      a repository UI in one file, as a template

  dependency direction:     shared ← core ← server ← cli
                            shared ← client ← web (and any repository's own UI)

<your-repo>/.tasks/         the workspace (per repository, never committed)
  tasks.config.json         that repo's settings
  data/tasks.db             its tasks, history and checkpoint results

<notes-folder>/             notes: Markdown files, in a Git repo of their own
  <slug>.md                 one note per file, frontmatter + Markdown
  attachments/<slug>/       images and files belonging to that note
  *.json                    issues fetched from GitHub / Azure DevOps, read-only
```

Notes are the exception to "it lives in the database": see [Notes](#notes).

## Prerequisites

- `bun` — the runtime, the package manager and the SQLite driver
- `aio-vr` on PATH — only needed for the checkpoint commands
- `gh` — only needed for the Branches view
- an agent CLI — `claude`, `codex` and/or `pi`, for PR descriptions and for running
  investigations and tasks from the UI. A terminal emulator too, if you want
  those runs to open a window you can talk to

## Install

```bash
git clone <this repo> ~/Source/WorkTaskManager
cd ~/Source/WorkTaskManager
bun install
bun run build          # builds the default UI into packages/web/dist
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

| Key                       | Default                                   | What it does                                                                             |
| ------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------- |
| `branchPrefix`            | `feature/`                                | Prefix for generated task branch names                                                   |
| `workPackageBranchPrefix` | `feature/`                                | Prefix for generated work package branch names                                           |
| `checkpointPrefix`        | `task-`                                   | Prefix for generated aio-vr checkpoint names                                             |
| `baseBranch`              | `null`                                    | PR base. `null` resolves it live: `gh repo view`, then `main`/`master`                   |
| `aioVrDir`                | `../.aio-vr`                              | The aio-vr workspace, resolved relative to `.tasks/`                                     |
| `aioVrBin`                | `aio-vr`                                  | The visual-regression executable to drive                                                |
| `notesDir`                | `../.notes`                               | Where notes live, resolved relative to `.tasks/`. Usually a sibling of the repo          |
| `notesAutoCommit`         | `true`                                    | Commit each notes change as it is made                                                   |
| `apiPort`                 | `5199`                                    | Port `tasks web` serves on                                                               |
| `webPort`                 | `5200`                                    | Port `tasks web --dev` serves Vite on                                                    |
| `prAgent`                 | `["pi","--no-session","-p","--no-tools"]` | Command that writes PR descriptions. `null` disables it                                  |
| `agentTerminal`           | `null`                                    | Command that opens a terminal window, with the agent's argv appended. `null` autodetects |
| `checks`                  | `[]`                                      | Commands that must pass before a PR may be opened. Empty leaves PRs ungated              |
| `modelTiers`              | `{}`                                      | Each harness's `fast`/`standard`/`frontier` tiers, resolved to a real model id           |

`prAgent` is a command plus its flags; the prompt is appended as one final
argument. Whatever you configure wants the equivalent of `--no-tools`: the
command is fired from a web request, so a tool-enabled agent could block on an
approval prompt with nobody at the terminal to answer it, and could touch the
working tree while you are mid-combine.

For Codex, the read-only unattended equivalent is
`["codex","exec","--sandbox","read-only","--ask-for-approval","never"]`.

`agentTerminal` is how "open a window with the agent running in it" is spelled,
and every emulator spells it differently — `["kitty","--hold"]`,
`["gnome-terminal","--"]`, `["wezterm","start","--"]`. The agent's own argv is
appended to it. Left `null`, the first of kitty, wezterm, ghostty, konsole,
alacritty, gnome-terminal, foot and xterm found on PATH is used; set it
explicitly to pin one or to pass it extra flags.

`modelTiers` decouples "how capable a model this task needs" from any real
model's name, so a task's recommendation (see below) still means the same thing
after a model lineup changes. It maps each harness to its three tiers:

```json
{
    "modelTiers": {
        "claude": { "fast": "haiku", "standard": "sonnet", "frontier": "opus" },
        "codex": {
            "fast": "gpt-5.6-luna",
            "standard": "gpt-5.6-terra",
            "frontier": "gpt-5.6-sol"
        },
        "pi": {
            "fast": "openai/luna",
            "standard": "openai/terra",
            "frontier": "openai/sol"
        }
    }
}
```

A harness with no entry, or a tier with no entry within one, just has nothing to
recommend for that combination — the model dropdown falls back to its own
default. Nothing else in the app ever names a real model except this file: a
task only ever carries a tier.

### Pre-PR checks

`checks` is the local half of CI: the commands that have to pass before this
tool will open a pull request. Each entry is a name, a command, the directory to
run it in, and optionally the paths it applies to.

```json
{
    "checks": [
        {
            "name": "frontend type-check",
            "command": ["bun", "run", "type-check"],
            "cwd": "frontend",
            "paths": ["frontend"]
        },
        {
            "name": "frontend lint",
            "command": ["bun", "run", "lint"],
            "cwd": "frontend",
            "paths": ["frontend"]
        },
        {
            "name": "backend build",
            "command": [
                "dotnet",
                "build",
                "Arcadis.Foundry.slnx",
                "--configuration",
                "Release"
            ],
            "cwd": "backend-modular",
            "paths": ["backend-modular"],
            "timeoutMs": 1500000
        }
    ]
}
```

- `cwd` is relative to the **repository root**, not `.tasks/` — a check belongs
  to a subproject, so `frontend` is what you want to write.
- `command` is argv, run without a shell: no quoting rules, and no `&&`. Two
  commands are two checks.
- `paths` restricts a check to branches whose diff against the base touches them.
  `frontend` matches everything under it; `*` and `**` work as usual. A check
  with no matching change is skipped, and a skip counts as a pass — which is
  what keeps the gate usable in a repository holding a frontend, a backend and a
  CLI at once.
- `timeoutMs` overrides the 15-minute default.

Run them from either end:

```bash
tasks checks                    # the current branch
tasks checks feature/t-12-thing --json
tasks checks --check cherry-pickable
```

Pass `--check <name>` to run one configured check. Its new result is merged
with the other results already stored for the same branch commit, so a
base-sensitive check such as `cherry-pickable` can be rerun after the base
branch moves without repeating unrelated builds and tests. If the checked
branch itself has moved, older results are discarded.

The Branches view has a **Checks** panel that can run all commands or any one of
them and shows each one's output. The result is stored against the branch, so a
green run from the CLI unblocks the PR button in the UI and vice versa. A report
goes stale as soon as the branch gets another commit.

**Run with supervisor** runs the suite with an agent standing by, like the
supervisor of an unattended work package run. Pick the agent, and when a check
fails it gets a headless `supervise-checks` run with the failing command and its
output. It fixes the failure, commits the fix on the branch, and ends on
`RESOLVED` or `UNRESOLVED`. It doesn't run the full check itself. On
`RESOLVED`, the app re-runs the failing check alone. If it still fails, the same
agent session is resumed with the new output. Once the check passes, the rest of
the suite runs against the new commit. Each check gets at most two supervisor
visits, counting resumes. After that, on `UNRESOLVED`, or when the supervisor
ends without a verdict, the run stops and the Checks panel says why. The
run also stops if the supervisor leaves uncommitted changes to tracked files,
because checks read the working tree but are recorded against the commit. The
supervisors' output is listed under the checks, and **Stop supervisor** ends the
run. Its prompt is `prompts/supervise-checks.md`, which you can override like
the other prompts.

The gate can be overridden — the PR panel offers "Open anyway, without passing
checks" whenever something is failing or stale. A check can be broken on master
or irrelevant to a docs-only branch, and a gate with no way past it gets worked
around instead of used.

Checks run against the **working tree as it stands**, not a fresh checkout of
the branch: nothing here switches branches under uncommitted work. Run them
while the branch is checked out; the report records which branch was actually
checked out, and the UI says so when it was a different one.

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
  --brief "It janks while dragging. Start at GanttChart.vue." --work-package WP-1
```

An investigation belongs to a work package, and a work package can have as many
as it needs — each is a tab on the work package's page. `--work-package` is
optional: one written down on its own gets a work package made for it when it
files its first task.

Then run it with the **`/plan-tasks I-1`** slash command in Claude Code, Codex or `pi`.
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
tasks work-package new "Plan improvements" --with-branch
tasks new "Make the plan gantt responsive" --work-package WP-1 --priority high --tag frontend
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

### Capturing `before` after the fact

Sometimes the change is already written when someone asks what the page used to
look like — or the scenario that would have shown it was only written once the
work exposed the need for it. The starting state was never captured, and the
code that produced it is now two commits back.

```bash
tasks checkpoint before T-1 --retro
```

That checks out the commit the task started from, runs the scenarios against it,
and puts you back on the branch you were on. The scenarios are **not** taken
from that old commit: `.aio-vr/` is ignored by Git, so the suite that runs is
today's, new and edited scenarios included. That is the whole point — a scenario
written after the change still gets a before image.

Which commit it travels to, in order:

1. `--at <commit>`, when you name one.
2. The commit the task's first `before` capture was taken at — a re-capture has
   to stand where the capture it replaces stood, or the comparison changes
   meaning. This is the case when you are adding a scenario to a checkpoint that
   already exists.
3. Failing both, where the task's branch was cut from the base branch.

`--dry-run` prints the commit it would use and stops, which is the quick way to
check the answer before committing a browser run to it.

Some care is taken because this moves your working tree:

- It refuses to start if any tracked file is modified. Untracked files are
  ignored — the visual-regression workspace is one.
- The branch you were on is restored in a `finally`, so a scenario that fails
  half way through the suite still leaves you where you were.
- An existing checkpoint is moved aside first and put back if the capture fails.
  `aio-vr before` deletes the checkpoint it is about to write, and a retroactive
  capture is usually run precisely because that evidence matters.

What it cannot do is rebuild your app. Whatever serves the pages — a dev server,
a container — has to notice the old code before the scenarios run against it.
`--settle <seconds>` waits after the checkout for exactly that:

```bash
tasks checkpoint before T-1 --retro --settle 10 --scenario constraints.edit-dialog
```

One caveat on the fork-point case: if the branch has been rebased, its fork point
is where it _now_ starts, not where the work originally began. `--at` is there
for when that matters.

## Baselines

Checkpoints and baselines are the same machinery pointed at different questions.

A **checkpoint** asks _"did my change move anything?"_ It is scoped to one task,
compares against what the page looked like when that task started, and is
deleted when the task closes.

A **baseline** asks _"does the app still look the way we agreed?"_ It is the
standing approved reference for every scenario, it belongs to the repository
rather than to any task, and drift accumulates against it whether or not anyone
was working — which is exactly the drift nobody notices until a release.

The **Baselines** view is the second one. It lists what differs from the
approved images, worst first, with `failed` above `changed` — a scenario that
could not render is a broken test, not a visual difference. Each row opens the
same comparison card the task checkpoints use (side by side, slider, diff), with
the left-hand image labelled **Baseline** and the right **Current**.

```bash
tasks baselines                       # what has drifted
tasks baselines --all                 # every scenario, drifted or not
tasks baselines run tools.detail      # re-run one scenario
tasks baselines approve tools.detail  # this change was intended
```

**Approve** promotes the current capture to be the baseline later runs are
measured against. It is offered one scenario at a time and only where it means
something — there is deliberately no "approve all", because it overwrites the
reference and there is no undo. The UI asks first, and names the percentage
being accepted.

A scenario already approved is marked as such: aio-vr records the approval
separately from the run, so an approved difference reads as expected drift
rather than as something new to look at.

`tasks baselines run` with no scenario re-runs the whole suite, which drives a
real browser through every scenario and takes minutes. Its non-zero exit means
"something drifted" — that is the normal state of a drift report, so it is
reported rather than treated as a failure.

Everything here is read from aio-vr's own files (`runs/latest/results.json` and
`runs/approvals.json`, wherever `aio-vr.config.json` puts them) and written by
aio-vr's own commands. This app never decides what a baseline is, and nothing
about baselines touches the task database.

## Scratch scenarios

Checkpoints and baselines both produce evidence that outlives the command. A
**scratch scenario** produces nothing anybody has to keep. It is the exploration
hatch: drive the app to some state that takes five steps to reach, add a
`console.log`, and read what it printed.

```bash
tasks scratch new login-debug --url https://localhost:5173
# edit .aio-vr/scratch/login-debug.cjs — it is a plain Playwright script
tasks scratch run login-debug
tasks scratch log login-debug          # re-read it after the output scrolled past
tasks scratch requests login-debug     # the API calls it made, with their bodies
tasks scratch clean --all              # delete the scenarios and their output
```

`tasks scratch run` streams everything the page logged as it arrives —
`console.log`, `console.warn`, `console.error` and uncaught exceptions, each
stamped with how far into the run it happened. The same transcript is saved to
`.aio-vr/scratch/out/runs/<name>.console.log`, which is what `tasks scratch log`
reads back and what `--json` returns.

It streams the **API calls** the same way, one line each, with status, timing,
size and both bodies:

```
┊ [0.012s] GET    200 OK         /api/tools?sort=name  3ms  48 B
┊ [0.020s] POST   200 OK         /api/login  1ms  28 B
┊ [0.022s] GET    404 Not Found  /api/missing  1ms  25 B
┊   ← {"error":"no such thing"}
┊ [0.526s] GET    FAILED net::ERR_CONNECTION_REFUSED /api/dead  1ms
```

A call that failed or came back non-2xx shows its body without being asked,
because that is invariably why you are looking; everything else stays one line
until you pass `--bodies`. The full transcript, bodies and all, goes to
`.aio-vr/scratch/out/runs/<name>.network.log` and is read back with `tasks
scratch requests`.

This only _listens_. It does not intercept, so it never alters a response and
works whether or not the scenario uses mocks — which matters, because turning
mocking on to find out what the page asked for would change the thing being
measured.

Only `/api/**` is recorded by default, the same filter the mocking layer uses.
Without it, a dev server that serves raw modules buries the two calls that
matter under four hundred `.ts` files. `--requests '<glob>'` (repeatable)
records something else instead; `--no-requests` skips capture entirely.

Request payload keys that look like credentials — `password`, `token`, `apiKey`
and friends — are replaced with `[redacted]` before anything reaches disk, since
a login flow is exactly the kind of multi-step state a scratch scenario exists to
reach. Responses are recorded verbatim: hiding the token a login call returns
would hide the thing being debugged.

Both transcripts are recorded for ordinary runs too — `tasks baselines run`,
`tasks checkpoint before|after` — but only written to file there, since fifty
chatty scenarios would bury the result.

To log from the scenario rather than from the app, evaluate in the page:

```js
console.log(await page.evaluate(() => window.__store.state))
```

When navigating to the URL is the whole story, `tasks probe --url <url>` takes
one screenshot with no file to create or clean up.

The isolation is aio-vr's: scratch scenarios live in `.aio-vr/scratch/`, a
_sibling_ of `scenarios/`, and discovery only ever reads `scenarios/`. So
nothing written there can fail the suite, be captured into a checkpoint, or be
promoted into a baseline — which is what makes it safe to hand to an agent that
is guessing. Nothing here touches the task database either.

## CLI

Run `tasks help` for the full list. Every command takes `--json`, which is what
agents should use.

| Command                                                                            | What it does                                                                                                                                                |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tasks init [--dir <path>] [--track]`                                              | Scaffold `.tasks/` in this repository                                                                                                                       |
| `tasks investigation list [--status s]`                                            | All investigations, unrun first                                                                                                                             |
| `tasks investigation show <ref>`                                                   | The brief, the findings, and the tasks it filed                                                                                                             |
| `tasks investigation new "<title>"`                                                | Create one. `--brief`, `--work-package`                                                                                                                     |
| `tasks investigation edit <ref>`                                                   | Change `--title`, `--brief`, `--findings`, `--status`                                                                                                       |
| `tasks investigation start\|complete <ref>`                                        | Move it along; `complete` takes `--findings`                                                                                                                |
| `tasks investigation rm <ref>`                                                     | Delete it; the tasks it filed are kept, unlinked                                                                                                            |
| `tasks list [--status s] [--tag t]`                                                | All tasks, in list order, in work package sections. `--investigation <ref>`, `--work-package <g>`, `--flat`                                                 |
| `tasks show <ref>`                                                                 | One task with its history and checkpoint results                                                                                                            |
| `tasks new "<title>" --work-package <g>`                                           | Create in a work package and assign a generated branch. Use `--no-git` for ignored/local-only work. `--no-visual` leaves visual-regression checkpoints out. |
| `tasks edit <ref>`                                                                 | Change metadata and dependencies; `--git` / `--no-git` toggles the task's Git workflow; `--visual` / `--no-visual` toggles visual regression.               |
| `tasks note <ref> <text>`                                                          | Append a note to the history                                                                                                                                |
| `tasks work-package list`                                                          | Every work package, in the order the list draws them                                                                                                        |
| `tasks work-package show <ref\|name>`                                              | One work package and everything in it                                                                                                                       |
| `tasks work-package new "<name>"`                                                  | Create one. `--brief` writes an investigation, `--with-branch` adds a branch, `--color`                                                                     |
| `tasks work-package edit <ref\|name>`                                              | Change `--name`, `--color`                                                                                                                                  |
| `tasks work-package branch list\|add\|edit\|rm <ref\|name>`                        | Its branches. `add --existing <b>` adopts one; `--name`, `--base`, `--label`, `--tasks`                                                                     |
| `tasks work-package branch assign\|unassign <ref> <branch> <task-ref>...`          | Which tasks a branch carries                                                                                                                                |
| `tasks work-package queue <ref\|name>`                                             | What is left in it, in dependency order — what `/work-package` follows                                                                                      |
| `tasks work-package add <ref\|name> <task-ref>...`                                 | Put tasks in it                                                                                                                                             |
| `tasks work-package rm <ref\|name>`                                                | Delete an empty work package                                                                                                                                |
| `tasks dep add <ref> <blocker-ref>...`                                             | Make the task wait for each blocker                                                                                                                         |
| `tasks dep rm <ref> <blocker-ref>...`                                              | Stop waiting for them                                                                                                                                       |
| `tasks dep list [<ref>]`                                                           | The dependency graph, or one task's corner of it                                                                                                            |
| `tasks move <ref> --top\|--bottom\|--up\|--down`                                   | Reorder the list                                                                                                                                            |
| `tasks move <ref> --before\|--after <ref>`                                         | Reorder relative to another task                                                                                                                            |
| `tasks branch <ref> [--from <branch>]`                                             | Create or switch to the task's assigned branch                                                                                                              |
| `tasks start\|done\|verify\|reopen <ref>`                                          | Move through status; branch enforcement and work package merging apply only when the task uses Git.                                                         |
| `tasks merge <ref>`                                                                | Merge the task into each of its target branches and register it there                                                                                       |
| `tasks checkpoint before\|after\|status <ref>`                                     | Drive aio-vr for one task                                                                                                                                   |
| `tasks checkpoint before <ref> --retro [--at <commit>] [--settle <s>] [--dry-run]` | Capture `before` at the commit the task started from                                                                                                        |
| `tasks baselines [--all]`                                                          | What has drifted from its approved baseline                                                                                                                 |
| `tasks baselines run [scenario...]`                                                | Re-run against the baselines                                                                                                                                |
| `tasks baselines approve <scenario>`                                               | Accept the current capture as the new baseline                                                                                                              |
| `tasks scratch new <name> [--url <base-url>]`                                      | Scaffold a throwaway scenario                                                                                                                               |
| `tasks scratch run [name...] [--headed]`                                           | Run it and stream everything the page logged                                                                                                                |
| `tasks scratch list\|log [name]\|clean [--all]`                                    | What exists, the last run's console output, and cleanup                                                                                                     |
| `tasks scratch requests [name]`                                                    | The API calls the last run made, with status, timing and bodies                                                                                             |
| `tasks probe --url <url> [--wait-for <sel>] [--out <path>]`                        | One screenshot of one URL, no scenario file                                                                                                                 |
| `tasks web [--port n] [--dev]`                                                     | Serve the Solid UI                                                                                                                                          |
| `tasks rm <ref>`                                                                   | Delete a task (the checkpoint on disk is left alone)                                                                                                        |

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

### Work packages

A **work package** is a named bundle of tasks — a feature, a release, or the output of
one investigation. A task is in **at most one** work package, which is what separates a
work package from a tag: tags stay free-form labels a task can carry any number of.

```bash
tasks work-package new "Search rework" --desc "Everything behind the new index"
tasks work-package add "Search rework" T-4 T-5     # by name or by ref (WP-1)
tasks list                                  # drawn in sections
tasks list --work-package "Search rework"          # just that work package
tasks list --flat                           # the bare queue, no sections
```

Both the task list and the **Plan** are drawn in those sections: the list gets a
collapsible heading per work package, the Gantt chart gets a band per work package with a bar
spanning that work package's earliest task to its latest. Turn either off — **Work package** in
the task list header, **Bands** on the plan — and you get the flat view back.

In `tasks web`, **drag a row onto a work package's heading** to move it into that work package,
or drop it among that work package's rows to land in a particular place. `Alt+↑`/`Alt+↓`
does the same thing from the keyboard: nudging a row across a section boundary
moves it into that section. Tick several rows and use **Move to work package…** to file
a batch at once. A task's work package can also be changed from the picker in its detail
pane, and `tasks work-package add` does it from the CLI.

**Organizing work packages does not reorder the queue behind your back — it keeps it readable.**
Sections are ordered by their first task in the queue, so the row at the top of
a grouped list is still the one `/work-task` picks up. Putting a task in a work package
moves it beside that work package's other tasks, which keeps a work package contiguous and the
grouped list reading in queue order; that is the one queue change organizing makes,
and both the CLI and the UI say so when they do it. Taking a task _out_ of a
work package leaves it where it is, so an unassigned row can sit further down the queue
than the section above it — `tasks list` numbers every row with its actual place,
and `tasks list --flat` shows the queue with no sections at all.

#### A work package delivers through branches

A work package has any number of **branches** — usually one; two when a fix has
to ship on a release branch as well as on main, or when a large package goes out
as two PRs. Each is a tab on the work package's page, and each carries an
explicit set of the work package's tasks.

```bash
tasks work-package branch add WP-1                           # feature/wp-1-search-rework
tasks work-package branch add WP-1 --existing release/2.4 --label "Release"
tasks work-package branch assign WP-1 Release T-4            # T-4 goes on both
```

- A **new branch** takes every task in the work package that is not yet Dev
  Complete. `--tasks T-1,T-2` or `--no-tasks` says otherwise.
- A **new task** joins the work package's newest branch. The branch's tab has a
  task selector for changing that.
- A branch is either **new** — named from the work package unless `--name`
  says otherwise, and cut from `--base` or the base branch — or an **existing**
  local branch adopted with `--existing`, commits and all.

Each task's `targetBranches` lists the branches it has to land on, oldest
assignment first. That is where its work adds up:

- `tasks branch T-4` cuts T-4's branch from its **first** target branch rather
  than from master, so a task starts with everything that branch has finished so
  far.
- `tasks done T-4` merges T-4 into **every** target branch and **registers it**
  on each. The first is rebased onto and fast-forwarded, as always; the others
  get a copy of just T-4's own commits, replayed the same way. Every branch
  stays a straight line of commits.

A new Git branch is created lazily, the first time a task on it is branched —
filing tasks under a heading does not put branches in your repository. A task on
no branch behaves exactly as a task in no work package did.

A branch tab distinguishes the local and remote names. **Rename local branch**
uses Git's branch rename, so the new name keeps the old branch's commits.
**Remote branch name** controls the name used by the next push and pull request
without changing the local branch. Leave it blank to use the local name
remotely. **Remove** forgets the tab; the Git branch is left alone.

**Rebase on master** (or whatever the base is), in the tab's Contents section, fetches the base and
fast-forwards it from `origin`, then replays the branch onto its tip. It needs a
clean working tree and puts you back on the branch you were on. A branch that
was already pushed is rebased anyway, since you asked for it, and the notice
warns that the next push has to force. A conflict aborts the rebase, so nothing
moves, and the tab asks whether to **resolve it with an agent**: Codex on its
`fast` tier by default, with the conflict report as its brief. The agent redoes
the rebase and finishes it, but does not push.

**Rebase on master with supervisor** asks for the agent first. If the rebase
stops on conflicts, it goes straight to a headless `resolve-conflicts` run.
Nobody is there to ask, so the supervisor settles disagreements itself, or
aborts if it can't. Git decides whether that worked, not the agent's reply: the
rebase counts only if none is left in progress and the base is an ancestor of
the branch. The tab shows the supervisor's progress and output, and puts you
back on the branch you were on. **Stop supervisor** stops the agent and aborts
its rebase, leaving the branch as it was.

#### Notes and issues

A work package page always has a **Notes** tab next to Tasks. It shows the notes
and issues attached to the work package together, as one grid of cards that
previews each one's content. A card's size follows how much there is to read: a
one-line note is a small tile, a long design note or a detailed bug report
spans two columns and several rows. Pick a note or an issue from the picker
above the grid and **Attach** it. Clicking a card opens it in its own view.
Attaching only records the reference: the Markdown file or issue JSON stays where
it is, and **Detach** leaves it there. A reference whose file has since been
removed drops out of the grid.

#### Tasks without a Git workflow

Some work belongs to ignored or machine-local files rather than product code.
Visual-regression scenarios in an ignored `.aio-vr/` workspace are the common
example. Create those tasks with `tasks new ... --no-git`, or turn off **Use Git
workflow** in the `web` task dialog.

A no-Git task still belongs to its work package, follows dependencies, records status,
and captures before/after checkpoints. It does not receive a task branch;
`tasks start` works from the current checkout, and `tasks done` does not merge
anything into the work package branch. The mode can be changed later with
`tasks edit <ref> --git` or `--no-git`.

```bash
tasks work-package new "Search rework" --with-branch   # feature/wp-1-search-rework
tasks work-package add "Search rework" T-4 T-5
tasks branch T-4                      # cut from feature/wp-1-search-rework
tasks done T-4                        # merged back into it, and registered
tasks branch T-5                      # cut from it too, so it has T-4's work
```

#### Tasks without visual regression

Not every task changes what a user sees. A task with visual regression turned
off is sent to the agent without the checkpoint steps: the instructions never
mention the visual-regression workflow, `tasks done` does not capture an
after-checkpoint, and the task still follows its work package, dependencies and
status. Set it when filing with `tasks new ... --no-visual`, change it with
`tasks edit <ref> --visual` or `--no-visual`, or tick or untick **Visual
regression** in the web task dialog. Checkpoints can still be taken by hand.

#### The work package page

Click **Open** on a work package's heading in `tasks web` (or go to `/work-packages/WP-1`, which
is a real, linkable route) for the work package's own page. Its first tab,
**Tasks**, lists the tasks and the **work order** — the work package's
unfinished tasks sorted so nothing comes before what it depends on. A task
waiting on something _outside_ the work package is called out, because working
the work package alone will never clear it.

After it comes a tab for each investigation, branch and run, in the order they
were added. **+** at the end of the tab bar adds another; **Rename** and
**Remove** on a tab's heading do what they say.

The **New work package** dialog has no description or branch field. **Add
investigation** and **Add branch** each add a section to fill in, as many as it
starts with — or none, and add them as tabs later.

`tasks work-package queue WP-1` is the same order from the CLI, and `--json` is what an
agent reads.

Finished tasks are marked **✓ merged** or **not merged** against a branch,
taken from the branch's own roster rather than guessed — a task that is Dev
Complete but not on its branch is the one thing you actually need to spot.

#### Next up

The work package page names the task to work next: the first in the work order that
nothing unfinished is holding up. **Start** points an agent at just that one
(`/work-task T-4`), branched from its first target branch like any other.

It never launches anything by itself. The queue _advances_ on its own — the page
re-reads on every change, so finishing a task moves this on to the next — but
pressing the button is yours. That is deliberate: `tasks done` fires while the
agent is still reporting back, so auto-launching the next one would put two
agents in the same working tree, both switching branches.

For the same reason it applies `/work-task`'s own rule and refuses while any
task is in progress — including a task in **another work package**, since the conflict
is the working tree, not the work package. When the in-flight task _is_ the next one,
the button reads **Continue** instead: that is resuming, not starting a second.

#### Runs

**Work with an agent** on the work package page works the package from start
to finish. The dialog lists the investigations not yet run, the task run, and
every branch without a pull request. You can untick any of them, including
the task run, to run only some stages: for example, just the branches for a
package whose tasks are done. You can also add investigations and branches in
the dialog. The run then goes in this order:

1. Each investigation, as a headless `/plan-tasks` told that nobody is there
   to answer questions.
2. The task run: choose **All open tasks** to include newly added tasks,
   including tasks filed by investigations, or **Selected tasks** to work only
   the tasks chosen in the dialog. A selected list stays fixed when resuming.
   Task agents use their own model setting, **Recommended for each task** by default.
3. Each branch: rebase on its base, generate the PR description, run all
   checks, then open the pull request. A branch that was rebased after it was
   pushed is force-pushed with lease first.

The dialog's one agent setting runs the investigations and is the supervisor
for everything after them: the task loop, a rebase that hits conflicts, and
failing checks. If a stage stops short, the whole run stops there and its tab
says why. **Resume** starts that stage again, and finished stages are not
repeated. Only one such run or unattended loop can run at a time across the
workspace.

**+ → Run** starts one of the other three kinds. Every run gets a **Run** tab:

- **Work next task** — `/work-task` on the next task nothing is holding up.
- **Guided work package run** — `/work-package WP-1`: one agent works every
  task in queue order, branching each from its first target branch and merging
  it into all of them — `/work-task` in a loop, with the order decided by
  `tasks work-package queue` rather than by the agent.
- **Unattended work package** — a fresh headless agent per task, with this
  server driving the queue between them. Always headless, and "Never ask"
  unless you pick otherwise. Its model picker can use **Recommended for each
  task**: the harness stays fixed, while each task's `fast`/`standard`/
  `frontier` tier is resolved through that harness's `modelTiers` mapping when
  its fresh agent starts. A task without a tier or mapping uses the harness
  default.

The tab says which kind it is, how it is going, and lists the tasks it set out
to work, each marked worked, working or still to work. **Stop** ends a run in
flight; **Resume in a terminal** reopens the agent's conversation.

An unattended run that stopped, failed or needs attention has **Resume run**. It
starts the loop again in the same tab. If the task it stopped on is left
unfinished, that task goes to a fresh agent. The new agent gets the task's
details, the reason the run stopped, the end of the last agent's output, and
paths to that agent's full log and conversation transcript. It picks up where
the last agent stopped instead of starting over.

An unattended run can also have a **supervisor**. Add one when starting the run,
or later with **Add a supervisor** on its tab, even while it is running. The
agent already at work is left alone, and the supervisor handles every stop after
that. The same button changes or removes it. This is a second agent config, with its own
harness, model, permissions and instructions. When a task's agent stops short of
Dev Complete, or reaches it without its work merged, the run calls in the
supervisor instead of stopping. The supervisor stands in for you. It makes the
decision the task's agent stopped to ask about, or fixes what broke, and it can
finish the task itself if that is simplest. It ends its report with `RESOLVED`
or `UNRESOLVED`:

- The task is done: the run moves on to the next task.
- `RESOLVED`: a fresh agent picks the task back up, given the supervisor's
  report along with the earlier agent's output.
- `UNRESOLVED` or no verdict: the run stops and waits for you, as it would
  without a supervisor.

A task gets at most two supervisor visits before the run stops for a person, so
it cannot go round in circles. **Resume run** starts that count again. The
supervisor's prompt is `prompts/supervise-task.md`. Like the other prompts, it
can be overridden in `.tasks/prompts/`.

Opening a task in the list shows the output of each agent that worked it. When
an agent has finished, its final answer is shown on its own and the working
behind it is folded away under **Show working**.

A run stops and hands back rather than guessing when a merge conflicts, a
dependency outside the work package is unmet, or a checkpoint fails. A stopped
run leaves the work package partly delivered, which is a normal state: the
tasks it did finish are merged and registered.

`tasks done --no-merge` skips the merges when you want to review first;
`tasks merge T-4` does them afterwards. A conflict aborts and leaves every
branch as it was; resolve it by hand, then `tasks merge T-4` registers the task
and carries on to any target branch it has not reached yet. Both are idempotent:
a task already on a branch is registered without a second merge.

A work package containing tasks cannot be deleted. Move its tasks into another work package
first; this keeps the mandatory membership invariant intact.

#### Tasks from an investigation are grouped automatically

Filing a task with `--investigation I-3` — which is what `/plan-tasks` does for
every task it files — puts it in that investigation's work package, on its
newest branch. An investigation written down on its own gets a work package,
with a branch, on the first task it files. A run of `/plan-tasks` therefore
arrives as one bundle you can collapse, filter and read as a unit rather than as
eight loose rows in the backlog.

The investigation points at its work package, not at its name, so renaming the work package
or re-running the same investigation refills the one that exists.

Tasks filed before work packages existed stay visible in the read-only **Unassigned**
compatibility work package — nothing rework packages them behind your back, but new tasks
cannot be added there. To organise a backlog that predates work packages, make the work packages and fill them:
`tasks work-package new "<investigation title>"` then `tasks work-package add <WP-n> <refs...>`,
which is the same thing you would do by hand anyway and leaves a history saying
who did it.

### Dependencies

A task can wait for other tasks: `tasks dep add T-4 T-2` records that T-4 needs
T-2 first. In the web UI the same thing is done from a task's **Dependencies**
section — pick a task from the list to wait for, or remove one — and that
section also shows what is waiting on _this_ task.

A blocker counts as met once it reaches **Dev Complete**: by then its work
exists on its branch, which is what the dependent task actually needs. Waiting
for a human's **Verified** sign-off would hold up work that is already unblocked.

Being blocked is **stated, never enforced**. A blocked task keeps its place in
the queue, keeps all its buttons, and is simply marked `⊘ waiting on …` in the
list and in `tasks list`. The order of the queue is a decision you make, and
starting something anyway is a judgement call rather than a mistake.

Circular dependencies are refused at the point they would be created — a cycle
means every task in it is blocked forever, which is never what was meant.
Deleting a task removes its edges; the tasks on either side of it stay.

#### Where a dependent task's branch is cut from

A finished dependency's work lives on **its** branch and nowhere else until it
is combined and merged. So `tasks branch <ref>` cuts a new branch from that
dependency's branch rather than from the base — otherwise the task would be
written against code that is not there. It says which start point it used.

- No dependencies, or none finished → the **base branch** (never whatever
  happens to be checked out).
- **One** finished dependency → that task's branch.
- **Several** finished dependencies → refused, because one branch cannot be cut
  from two. Combine them into a delivery branch first, then
  `tasks branch <ref> --from <that-branch>`.
- `--from <branch>` overrides all of it.

An existing branch is switched to unchanged; this only chooses a start point
when the branch is being created. When the task is still waiting on something,
`tasks branch` says so and carries on — it does not refuse.

### Branches

Every newly created task is assigned a Git-valid branch name, generated as
`<branchPrefix>t-<n>-<title-slug>` unless `--branch` supplies an override. Use
`tasks branch <ref>` to create or switch to it; `tasks start` refuses to begin
work from another branch. Existing `backlog` and `in_progress` tasks are
backfilled when the database is first opened. Historical completed tasks are
left unassigned.

A new branch is cut from the task's **first target branch** when it has one (see
[A work package delivers through branches](#a-work-package-delivers-through-branches)), otherwise from the branch of a
finished task it depends on, otherwise from the base branch — never from
whatever happens to be checked out. `--from <branch>` overrides all of that.

### For agents

```bash
tasks investigation list --json        # what is waiting to be investigated
tasks investigation show I-1 --json    # the brief to work from
tasks list --json                      # the queue, top first
tasks list --status in_progress --json # is something already being worked?
tasks show T-1 --json                  # full detail incl. per-scenario results
tasks dep list --json                  # the dependency graph, with what is blocked
tasks dep add T-4 T-2                  # T-4 waits for T-2
tasks work-package list --json                # the work packages, and how much is in each
tasks work-package add "Search rework" T-4    # put a task in one (by name or ref)
tasks notes list --json                # what has been written down
tasks notes show <path> --raw          # the Markdown body, nothing else
tasks issues list --json               # every issue fetched into the notes folder
tasks issues show 677 --json           # one issue in full, body included
tasks checkpoint after T-1 --json      # capture and get the comparison back
tasks done T-1 --json                  # capture + transition in one step
```

Three commands wrap this. Their instructions ship as Markdown in this package's
`prompts/` folder and are inlined into the agent's first message at launch time
(see [Running an agent from the UI](#running-an-agent-from-the-ui)) — nothing
has to be installed globally in Claude Code, Codex or `pi` for them to work:

- **`/plan-tasks [I-<n>]`** — runs an investigation that was written down in the
  Investigations view: reads the brief, investigates the codebase, files what it
  finds as tasks linked to that ref, and writes its findings back. Each
  description carries enough detail that the next agent does not have to repeat
  the investigation. It changes no code. With no ref it takes the investigation
  waiting to be run. When the brief names an issue (`#677`, an issue URL, a work
  item), it reads that issue first — see [Issues](#issues). Where a split leaves
  a real ordering — the API cannot be written before its schema — it records that
  as a [dependency](#dependencies) rather than a sentence in a description. The
  tasks it files land in a [work package](#work-packages) for that investigation automatically,
  so a run arrives as one bundle rather than as loose rows. It also judges each
  task's `fast`/`standard`/`frontier` tier — how much model capability the work
  looks like it needs — which becomes the model dropdown's starting value on a
  `work-task` run, resolved through `modelTiers` in `tasks.config.json`.
- **`/work-task [ref]`** — drives one task through its configured workflow:
  normally branch → `checkpoint before` → change → `checkpoint after` →
  `tasks done`; a no-Git task skips the branching, commit, and merge steps.
  With no ref it takes the task at the top of the list. It stops rather than
  starting a second task when one is already `in_progress`, and stops to ask when
  the task is waiting on a [dependency](#dependencies) that is not finished. It
  branches from the task's first [target branch](#a-work-package-delivers-through-branches) when it has one,
  otherwise from a finished dependency's branch, otherwise from the base — and
  reports which. It also owns the **scenario coverage** of its own change: if the
  task moves something a user can see, a scenario has to show it. One is written
  before the `before` capture when nothing covers the state yet, and when the
  `after` comes back `unchanged` on work that was meant to be visible, the
  scenario is added or extended and the before state recaptured with
  [`--retro`](#capturing-before-after-the-fact).
- **`/work-package <WP-n>`** — the same thing for a whole [work package](#work-packages), one task
  at a time, in the order `tasks work-package queue` gives. Git-workflow tasks are
  branched from their first target branch and merged into every one; no-Git tasks skip those
  steps. It requires a ref — a work package is a commitment to its branches, and guessing
  which one is not something the user recovers from by noticing later. It stops
  and hands back on a merge conflict, on a dependency outside the work package, or on a
  failed checkpoint, leaving the tasks it did finish merged and registered.

The natural pairing is `/plan-tasks` to fill the backlog, then `/work-task` or
`/work-package` to empty it. All three can also be fired from the web UI against
whatever is on screen — see
[Running an agent from the UI](#running-an-agent-from-the-ui).

`--json` on a capture suppresses aio-vr's progress output and returns a single
JSON document: the run, its per-scenario comparisons, and the updated task.
`tasks done --json` also carries a `captureError` field — the transition still
happens if the capture fails, so this is how you find out that it did.

## Running an agent from the UI

Every command can be fired from the web UI rather than typed into a terminal,
against whatever is on screen:

| Where                       | Button                 | What it runs                                                            |
| --------------------------- | ---------------------- | ----------------------------------------------------------------------- |
| Issues → an open issue      | **Investigate**        | `/plan-tasks #677`                                                      |
| Investigations → **Run it** | **Run it here**        | `/plan-tasks I-3`                                                       |
| Tasks → a selected task     | **Work with agent**    | `/work-task T-12`                                                       |
| A work package's page       | **Work with an agent** | Investigations → open tasks → branches to PR, as a Run tab              |
| A work package's page       | **+ → Run**            | `/work-task`, `/work-package WP-1`, or an unattended loop, as a Run tab |

Every resumable run records a **session id**, so **Resume** on a run — the one on screen, or any
in the run history — opens a new terminal window on that same conversation
(`claude --resume <id>`, `codex resume <id>`, `pi --session-id <id>`). It does not start a new run;
it is the same session, opened again, so the history does not claim the agent
was launched twice. Claude Code and pi accept an id generated at launch. Codex
generates its own, so the server finds it afterwards in `~/.codex/sessions`
(or `$CODEX_HOME/sessions`). It takes the session that started in the run's
directory within two minutes of the launch, containing the prompt this app sent,
that no other run has claimed. Until that file appears, Resume stays disabled.
An investigation's tab lists its runs with the same Resume button.

The dialog takes an optional extra prompt, the harness (**Claude Code**,
**Codex** or **pi**, whichever is on PATH) and the model. Claude Code cannot
list its own models, so it offers the tier aliases — `opus`, `sonnet`, `fable`,
`haiku` — which track the current model of each tier. Codex reads the user-visible
models from the CLI's local catalogue and includes any additional configured tier
models. `pi` is asked for its catalogue with `pi --list-models` and offers all of
it, grouped by provider. Any harness can use its own default.

The extra prompt goes _below_ the command, so the command still gets its ref as
its first argument. Investigate on an issue runs against the issue itself —
`/plan-tasks` looks it up through `tasks issues show`, reads the reporter's own
words, and files what it finds. Nothing creates an investigation record first;
the command decides whether the question is worth writing down.

### Two ways to run it

**Open a terminal window** launches a real terminal with the agent interactive
inside it. This is the one to reach for: the agent can ask, you can answer, and
you can steer it mid-run. This app's involvement ends at the launch — the window
is a session of its own, and whatever it files shows up in the UI as it happens.
Needs `agentTerminal`, or a known emulator on PATH.

**Headless (`-p`)** runs it detached with stdout and stderr captured to a log
the dialog streams back, so it survives closing the tab and can be stopped from
the same dialog. Nobody is at a terminal to approve a tool call, which is why
its permission mode defaults the way it does — see below.

### What it may do without asking

Claude Code and Codex both expose permission controls for interactive and
headless runs. `pi` has no equivalent and the control is hidden for it.

| Choice         | Claude Code flag                      | What it means                                                                                                                                         |
| -------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ask every time | _(none passed)_                       | Claude's own default: it asks before each edit and each command.                                                                                      |
| **Auto**       | `--permission-mode auto`              | Edits and safe commands go through unasked; risky ones still stop to ask. The mode Shift+Tab reaches inside the terminal UI — this just starts there. |
| Plan only      | `--permission-mode plan`              | Reads and proposes, changes nothing.                                                                                                                  |
| Never ask      | `--permission-mode bypassPermissions` | Asks about nothing at all.                                                                                                                            |

For Codex these choices map respectively to no flag, `--approve-for-me`,
`--sandbox read-only`, and `--dangerously-bypass-approvals-and-sandbox`.

"Ask every time" is the one mode expressed by passing _no_ flag rather than by
naming it, so a `claude` build that spells these modes differently still works.

A terminal run defaults to **Auto** — it is interactive, so the questions worth
asking still get asked. A headless run defaults to **Never ask**, because it is
the only mode it can finish in: both commands are mostly shell (`tasks …`,
`git …`), so anything else stops dead on the first one with nobody there to
answer. Choosing something else for a headless run is allowed and the dialog
warns that it will probably stall.

Every launch is recorded — harness, model, mode, the exact argv and the prompt —
and the last runs for whatever you are looking at are listed in the dialog, so a
headless log can be reopened later. Runs are children of `tasks web`: restarting
the server ends the headless ones, and anything left claiming to be running is
settled on the next start rather than believed. A terminal window outlives the
server, as it should.

The browser never sends a command line. It sends the intent — which command,
against what, with what extra prompt — and the server builds the argv. That is
what stops a page being able to ask this server to run anything it likes.

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
yet. When the folder ends up _inside_ the repo (which the `../.notes` default
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

Attachments are stored per note under `attachments/`, and linked _relatively_
(`../attachments/ideas/gantt-is-slow/screenshot.png`) so the Markdown renders
anywhere. The web app resolves those links through the API, which refuses any
path that escapes the notes folder.

### Git

With `notesAutoCommit` on (the default) every write — save, attach, rename,
delete — is committed as it happens, so the history is Git's rather than
nobody's. A failed commit never loses the edit: the file is written first, and
`tasks notes sync` picks up whatever could not be committed. The Notes view shows
the branch, the uncommitted count and the unpushed count, with **Sync**,
**Commit** and **Push** buttons for a folder that has a remote.

**Sync** fetches the notes repository and brings it up to date with what came
back — the "go and get what everyone else wrote" action. Usually that is a
fast-forward. When both sides have commits it merges, but only from a clean
folder, and a merge that stops on conflicts is aborted, never left in the tree.
Every save auto-commits, and committing conflict markers into a note would be
worse than not merging. The view then asks whether to **resolve the conflicts
with an agent**. By default that is Codex on its `fast` tier, or its Luna model
when no tier is configured. The agent runs in the notes folder, repeats the
merge, resolves it and commits, but does not push. Decline, and nothing changed.
Sync does not commit first either — the Commit button beside it does that, and
quietly committing a half-written note because you asked to pull would be a
surprise.

Fetching and pushing are the only operations here that talk to a network, and
neither is automatic.

### Sync a task's VR evidence

Use **Sync VR to notes** beside the capture buttons in a task's **Visual
checkpoints** section, or run:

```bash
tasks checkpoint sync T-1
tasks checkpoint sync T-1 --json
```

The Notes page keeps these exports in a separate **VR notes** category, hidden
from the default All and Notes lists. Select **VR notes** to browse the reports
and filter by repository/task folder. **Open report** on a task opens its report
directly; returning to the library keeps the VR category selected.

Initialize the configured notes repository with `tasks notes init` first. Each
sync exports and commits just that task's evidence locally; the Notes **Push**
button or `tasks notes sync --push` publishes the commits to your remote.

```text
.notes/visual-regression/<repository-name-and-hash>/T-1/
  README.md         # comparison tables and relative screenshot links
  manifest.json     # task details, history, all runs and original raw results
  artifacts/
    checkpoints/<checkpoint-name>/  # screenshots, metadata, results and logs
    scenarios/                     # referenced scenario definitions
```

The repository namespace keeps task references from different repositories
separate when they share a notes repo. The report includes per-scenario percent
changed, changed and total pixel counts, browser log changes, capture times,
Git state, and links to before, after and diff images. The manifest includes
an overall percent changed weighted by pixel counts (when all pixel counts are
available), scenario filters, raw run data, source-to-export path mappings, file sizes and
SHA-256 checksums. Paths in the report are relative so the export can be read
from another clone without the task database or aio-vr workspace.

aio-vr reuses screenshot paths between captures. Exported files contain the
current evidence on disk, while the manifest preserves every recorded run's
metadata. Earlier synced screenshots are retained in the notes Git history.
Missing source files are listed in the report and sync result. If all screenshots
have been cleaned away, syncing fails and keeps any previous export. Repeating
an unchanged sync creates no new commit. Unrelated note edits, including staged
edits, stay out of the task's commit.

### CLI

```bash
tasks notes list [--tag t] [--folder f] [--search q]
tasks notes show <path> [--raw]        # --raw prints the body alone, for pipes
tasks notes new "<title>" [--folder ideas] [--body -] [--tag t]
tasks notes edit <path> [--title t] [--body -] [--append -] [--rename <path>]
tasks notes open <path>                # $EDITOR on the real file, then commit
tasks notes attach <path> <file>...    # copy files in and link them
tasks notes images [<note|folder>]     # where the images are, by absolute path
tasks notes index                      # give folders of loose images a note
tasks notes rm <path>
tasks notes sync [--push]
tasks notes status
```

`--body -` and `--append -` read from stdin, which is how an agent writes a long
note without quoting it. `tasks notes <path>` is shorthand for `show`.

### Images already on disk

Most images in a notes folder were never uploaded through this app — they were
dropped in by a screenshot tool, synced from Obsidian, or copied out of a board
export. Two rules make those visible without moving anything:

- **Images sitting beside a note** are listed as its attachments, alongside
  anything uploaded into `attachments/`. Only images: a folder of notes is also
  full of files that are not attachments of anything, and fetched issue JSON
  under whichever note shares its directory would be noise.
- **A folder of loose images with no note in it** gets one, titled after the
  folder and linking every image. The Notes view does this each time it reads
  the list, so images copied into the folder show up on the next refresh;
  `tasks notes index` does the same from a terminal.

Indexing only ever _creates_, and only where there is no note to overwrite, so a
note you wrote is never edited or re-linked. Add a fourth image to a folder that
already has a note and it appears in that note's attachments instead.

Clicking an image — a thumbnail in the attachments strip, or one in the rendered
note itself — opens it full-screen over the note. Escape closes it, so does the
backdrop or the ✕; the arrow keys step through the rest of that note's images.

### Reading images from a terminal

`tasks notes images` does not draw anything. A terminal cannot show a screenshot,
and an agent reading the output cannot see one either — but it _can_ open a file,
if something tells it which file. So the command answers with locations:

```bash
tasks notes images                      # every image, grouped by the note it belongs to
tasks notes images <note.md>            # one note's images
tasks notes images <folder>             # everything under a folder
tasks notes images --paths              # absolute paths, one per line, nothing else
tasks notes images --json               # paths plus sizes and owning note
```

`--paths` is the agent-shaped one: hand a line of it to whatever actually reads
images and it will work, because the path is absolute and already resolved. It
pipes, too — `tasks notes images --paths | xargs -d '\n' feh`.

## Issues

The Notes & issues page reads every `.json` file in the notes folder, recognises
the ones that describe an issue, and shows them as cards alongside the notes.
Every card, note or issue, has **Add as task** and **Add as investigation**,
which copy its text into a new task or investigation in a work package. **Nothing here talks to an issue
tracker.** Whatever produces the files — `gh issue view --json`, a script, an
agent — is somebody else's job; this view is a reader, and the files are re-read
on every request, so replacing one and switching back to the tab is the whole
refresh story.

The one network action is **Sync** in the sidebar: it fetches and fast-forwards
the notes repository, which is where the issue files live, so issues somebody
else committed appear without leaving the view. It is the same button, and the
same pull, as the one in the Notes view — see [Git](#git) above for exactly what
it will and will not do. A merge conflict is only reported here; resolving it
with an agent is offered from Notes.

Both of these are understood, along with the bare provider response and a bulk
export (an array, or Azure DevOps' `{ count, value: [...] }`):

```jsonc
{ "source": "github",       "fetchedAt": "…", "issue":    { /* GitHub's issue    */ } }
{ "source": "azure-devops", "fetchedAt": "…", "workItem": { /* an ADO work item  */ } }
```

`source` is trusted when it is there and sniffed from the shape when it is not —
a `fields` bag of `System.*` keys is a work item, a `number` + `html_url` is a
GitHub issue. JSON that is neither is ignored rather than reported: the notes
folder is allowed to contain other files.

The card shape is the **lowest common denominator** — key, title, state, type,
labels, assignees, when it last moved — because that is the part GitHub and Azure
DevOps agree on. Each provider's own vocabulary survives next to it rather than
being flattened away: `stateLabel` keeps `Active` or `not_planned` as written,
`kind` keeps `Bug` or `User Story`, and the detail view carries the provider's
untouched JSON under **Raw JSON**. A source with no colour or no labels (ADO tags
have neither) renders as itself rather than as a gap.

Descriptions are rendered with the same escaping Markdown renderer the notes use.
Azure DevOps returns HTML, which is **flattened to text first** and never passed
through as markup — these files come from outside this tool, and there is no
sanitiser here worth trusting with them.

### CLI

```bash
tasks issues list [--state open|closed|all] [--source <s>] [--label <l>] [--search <q>]
tasks issues show <#number|id|title> [--raw]
tasks issues 677                       # shorthand for show
```

`show` takes whatever you have: the number, the file name, the full id, or enough
of the title to be unambiguous — an ambiguous reference lists the candidates
rather than picking one. `--raw` prints the provider's own JSON, for anything the
flattening left behind. Both commands take `--json`.

This is also how `/plan-tasks` reads an issue named in an investigation brief: it
looks the issue up and works from the reporter's own words rather than from the
one-line pointer. It never fetches — if the file is not there, it says so.

Adding a provider is a `fromX()` adapter in `packages/core/src/issues.ts`, a line in
`ISSUE_SOURCE_LABELS`, and a colour for `.issue-card.source-x` in the stylesheet.
The view, the filters and the card need no changes.

## Web UI

`tasks web` serves the API under `/api` and a UI at everything else, on the
configured API port. The UI is the repository's own when its config has a `ui`
key (see [A repository's own UI](#a-repositorys-own-ui)), and the default Solid
2.0 frontend otherwise. `tasks web --default-ui` serves the default one
regardless. `tasks web --dev` runs the chosen UI's dev server alongside the API.

The default frontend lives in `packages/web` and talks to the server only
through `@work-task-manager/client`, exactly as a repository's UI would. Build
it with `bun run build`. The rail opens
**Work packages**, **Notes**, and **Issues**. Each work package brings together
its investigation, tasks, agent runs, branch checks, and delivery controls.
Selecting a task opens its workflow and visual evidence.

The Solid prerelease references are vendored in
[`docs/solid-2.0`](docs/solid-2.0/README.md).

### A repository's own UI

The backend owns the domain: membership, ordering, dependency order, status
transitions, Git state, what a check run means. A UI renders what the API
returns and sends intents back. That is what makes a second UI cheap, and a
repository can ship one shaped around its own workflow.

1. Build it against `@work-task-manager/client`:

    ```ts
    import { createClient, STATUS_LABELS } from "@work-task-manager/client"

    const api = createClient() // same origin; or { baseUrl: "http://localhost:5199" }
    const workPackages = await api.listWorkPackages()
    const detail = await api.getWorkPackage(workPackages[0].ref)
    const stop = api.subscribe(({ channel }) => {
        if (channel === "tasks") rerender() // the CLI, an agent or another tab wrote
    })
    ```

    Every method is typed with the API's own types, which the package re-exports.
    Errors come back as `Error`s carrying the server's message. Nothing depends on a
    UI framework. [`examples/minimal-ui`](examples/minimal-ui/src/main.ts) is a
    complete one in about 70 lines.

2. Point the repository's `.tasks/tasks.config.json` at it. Paths are relative to
   the repository root:

    ```json
    {
        "ui": {
            "dist": "tools/tasks-ui/dist",
            "cwd": "tools/tasks-ui",
            "build": ["bun", "run", "build"],
            "dev": ["bun", "run", "dev"],
            "origins": ["http://localhost:5300"]
        }
    }
    ```

    | Key       | Meaning                                                                                        |
    | --------- | ---------------------------------------------------------------------------------------------- |
    | `dist`    | The built static files (required). `"ui": "path/to/dist"` is shorthand for only this.          |
    | `cwd`     | Where `build` and `dev` run. Defaults to the repository root.                                  |
    | `build`   | Run by `tasks web` when `dist` has no `index.html` yet.                                        |
    | `dev`     | Run by `tasks web --dev` beside the API, with `TASKS_API_URL` and `TASKS_API_PORT` in its env. |
    | `origins` | Browser origins allowed to call the API cross-origin. Exact matches only, never a wildcard.    |

    Served by `tasks web`, the UI shares the API's origin and needs no
    configuration. A dev server either proxies `/api` to `$TASKS_API_URL` (as the
    default UI's Vite config does) or calls it directly with `baseUrl`, in which
    case its origin goes in `origins`.

`GET /api` answers `{ name, apiVersion, repoRoot }`, so a UI can check it is
talking to a server whose contract it was built for. `GET /api/routes` lists
every route with its method, path and a one-line summary.

What a UI would otherwise work out for itself comes with the data:

| Field                        | Meaning                                                                  |
| ---------------------------- | ------------------------------------------------------------------------ |
| `Task.statusSince`           | `{ verb, at }`: when it entered its status and what to call that moment. |
| `Task.blockedBy`             | Its unfinished blockers, checked across the whole workspace.             |
| `WorkPackage.lastWorkedAt`   | Latest of creation and any task starting or finishing; sort by it.       |
| `WorkPackageDetail.nextTask` | The first task in the work order that nothing unfinished holds up.       |
| `WorkPackageDetail.tabs`     | Investigations, branches and runs in the order added, with stable keys.  |
| `/api/meta` labels           | `statusLabels` and `investigationStatusLabels` for display.              |

The API can also be embedded rather than run as `tasks web`:
`@work-task-manager/server` exports `handleApiRequest(request)` (the whole API as
a `Request → Response` function), `prepareWorkspace()` (call it once first) and
`startServer({ port, ui, origins })`. It also exports `createRouter` and `route`,
the same pieces its own routes are built from.

### How the API is organised

- `packages/server/src/routes/` has one module per resource (`tasks.ts`,
  `workPackages.ts`, `branches.ts`, …). Each exports a list of
  `route(method, path, summary, handler)` entries. A handler returns a value
  (sent as JSON) or a `Response`, and throws `HttpError` for a specific status.
- `router.ts` matches by segment: a literal segment beats a `:param`, so
  `/tasks/reorder` is never read as a task. Params arrive percent-decoded. A
  path with no route is a 404, and a known path with the wrong method is a 405.
- Routes parse and validate the request, then call `@work-task-manager/core`.
  Business rules (combining branches, signing off a package, rebasing with a
  supervisor, editing config) live in core, mostly `delivery.ts`, so the CLI and
  an embedding server get the same behaviour.
- `packages/client/src/contract.test.ts` calls every client method against a
  fake `fetch` and checks each request against the route table, in both
  directions. A route added without a client method, or a client method
  pointing at a route that does not exist, fails the tests.

Run the tests with `bun run test`. It passes `--isolate`, because each test file
points the workspace at its own sandbox and the workspace is cached per process.

### Upgrading to work package tabs

Opening an existing database moves each work package's single investigation and
branch into tabs, once: the investigation is linked to its work package, and the
branch becomes a **Branch** tab carrying every task the work package had. A
description with no investigation behind it becomes one. Nothing moves in Git.

`tasks work-package new/edit` no longer take `--desc` or `--branch`; use
`--brief`, `--with-branch` and `tasks work-package branch`. The API's
`WorkPackage` loses `description`, `branchName` and `investigationRef`;
`WorkPackageDetail` has `investigations`, `branches` and `workRuns` in place of
`git` and `delivery`, and each task carries `targetBranches`.

### Upgrading from groups

Existing databases upgrade automatically in a transaction. Work package membership,
note attachments and run history are retained. Existing `G-` references and Git
branch names stay valid; new work packages receive `WP-` references and default
to branches under `feature/`.

Use `tasks work-package`, `--work-package`, and the `/work-package` agent
command. The old CLI `group`/`groups` commands and `--group` option remain
aliases for existing scripts. Existing browser links under `/groups/` still open.
The API now uses `/api/work-packages`, `workPackage`, `workPackages`, and
`workPackageRef`; API consumers must update those names. Configuration uses
`workPackageBranchPrefix`, with `groupBranchPrefix` accepted as a fallback. For example:

```json
{ "workPackageBranchPrefix": "delivery/" }
```

Workspace prompt overrides should use `.tasks/prompts/work-package.md`;
existing `work-group.md` overrides remain a fallback.

## How it fits together

- **Two roots, deliberately.** The _package_ is where the tool is installed —
  the core and its prompts, the server, the default UI. The _workspace_ is the `.tasks/` folder
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
- **Live updates carry no data, only a channel.** There is nothing to subscribe
  to in SQLite or in a folder of Markdown, so `packages/core/src/watch.ts` watches what
  they actually are — files — and says "the database moved" or "the notes folder
  moved". Sending the new state down that stream would mean a second definition
  of what each view needs, in parallel with the one the views already have, and
  one of the two would rot. Writes made through the server announce themselves
  directly as well, so live updates still work on a filesystem whose change
  notifications do not.
- **A work package is one column on the task, not a join table.** A task belongs to at
  most one work package, so expressing membership as a nullable `work_package_ref` makes that a
  fact of the schema rather than a rule something has to enforce — and organizing
  stays one write, which is what lets a drag change a row's work package and its place
  in the queue in one gesture. The ref is plain rather than a foreign key, the
  same as an investigation's: deleting the organizing must never delete the work.
  Both views section the list through one shared function (`workPackageTasks`), so the
  list and the plan cannot disagree about what the organizing is.
- **Notes go the other way on purpose.** Workflow state — statuses, transitions,
  queue order — is what a database is for. Prose is not: it wants to be a file
  somebody else's tools can open, and a history somebody else's clone can pull.
  So notes are files, their folder is a repository, and this tool is one of
  several ways to write them rather than the only one.
- Issues are **read-only and provider-shaped at the edge**. One adapter per
  provider flattens a file into a common card; everything downstream of that —
  the board, the filters, the detail view — knows nothing about GitHub or Azure
  DevOps. That is what stops the second provider being a rewrite of the first.
- The Markdown preview is rendered by a small renderer in `packages/web/src/markdown.ts`
  rather than a dependency. It escapes the source before any rule runs, so the
  only markup in the output is the markup it emits — which is what makes it safe
  to preview a note written by an agent or pulled from someone else's clone.
  Everything that displays stored prose goes through it (the shared Markdown renderer):
  investigation briefs and findings, task descriptions, issue bodies and PR
  descriptions were all written as Markdown, so all of them are read as
  Markdown. **Copy** on such a block copies the _source_, because the reason to
  copy any of it is to paste it somewhere that wants the Markdown back.

## Caveats

- `aio-vr` rewrites `results.json` in the checkpoint directory on every run,
  including `before`. A failed `after` therefore leaves the _previous_ file in
  place; the integration checks `generatedAt` against the time the run started
  and refuses stale results rather than recording a comparison that never
  happened.
- Recordings freeze API data but not the clock, so date-driven UI drifts against
  a fixed checkpoint as real time moves on.
- Each repo's database is local and untracked. It is not shared between
  machines.
