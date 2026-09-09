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
work-task-manager/          the tool (this repo, installed globally)
  bin/tasks                 CLI entry point — resolves bun, then runs the CLI
  dist/web/                 built web UI, shipped with the package
  src/
    config/                 workspace discovery + per-repo settings
    shared/                 types shared by the CLI, server and web app
    server/                 bun HTTP API + SQLite + the aio-vr integration
                            (watch.ts streams workspace changes to open tabs)
    cli/                    the `tasks` command
    web/                    Vue 3 single-page app

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
bun run build:all      # builds the Vue UI and Solid proof of concept
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

| Key                 | Default                                   | What it does                                                                             |
| ------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------- |
| `branchPrefix`      | `feature/`                                | Prefix for generated task branch names                                                   |
| `groupBranchPrefix` | `group/`                                  | Prefix for generated group branch names                                                  |
| `checkpointPrefix`  | `task-`                                   | Prefix for generated aio-vr checkpoint names                                             |
| `baseBranch`        | `null`                                    | PR base. `null` resolves it live: `gh repo view`, then `main`/`master`                   |
| `aioVrDir`          | `../.aio-vr`                              | The aio-vr workspace, resolved relative to `.tasks/`                                     |
| `aioVrBin`          | `aio-vr`                                  | The visual-regression executable to drive                                                |
| `notesDir`          | `../.notes`                               | Where notes live, resolved relative to `.tasks/`. Usually a sibling of the repo          |
| `notesAutoCommit`   | `true`                                    | Commit each notes change as it is made                                                   |
| `apiPort`           | `5199`                                    | Port `tasks web` serves on                                                               |
| `webPort`           | `5200`                                    | Port `tasks web --dev` serves Vite on                                                    |
| `prAgent`           | `["pi","--no-session","-p","--no-tools"]` | Command that writes PR descriptions. `null` disables it                                  |
| `agentTerminal`     | `null`                                    | Command that opens a terminal window, with the agent's argv appended. `null` autodetects |
| `checks`            | `[]`                                      | Commands that must pass before a PR may be opened. Empty leaves PRs ungated              |
| `modelTiers`        | `{}`                                      | Each harness's `fast`/`standard`/`frontier` tiers, resolved to a real model id           |

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
```

The Branches view has a **Checks** panel that runs the same commands and shows
each one's output. The result is stored against the branch, so a green run from
the CLI unblocks the PR button in the UI and vice versa. A report goes stale as
soon as the branch gets another commit.

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
  --brief "It janks while dragging. Start at GanttChart.vue."
```

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
tasks group new "Plan improvements"
tasks new "Make the plan gantt responsive" --group G-1 --priority high --tag frontend
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

## CLI

Run `tasks help` for the full list. Every command takes `--json`, which is what
agents should use.

| Command                                                                            | What it does                                                                                                                  |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `tasks init [--dir <path>] [--track]`                                              | Scaffold `.tasks/` in this repository                                                                                         |
| `tasks investigation list [--status s]`                                            | All investigations, unrun first                                                                                               |
| `tasks investigation show <ref>`                                                   | The brief, the findings, and the tasks it filed                                                                               |
| `tasks investigation new "<title>"`                                                | Create one. `--brief`                                                                                                         |
| `tasks investigation edit <ref>`                                                   | Change `--title`, `--brief`, `--findings`, `--status`                                                                         |
| `tasks investigation start\|complete <ref>`                                        | Move it along; `complete` takes `--findings`                                                                                  |
| `tasks investigation rm <ref>`                                                     | Delete it; the tasks it filed are kept, unlinked                                                                              |
| `tasks list [--status s] [--tag t]`                                                | All tasks, in list order, in group sections. `--investigation <ref>`, `--group <g>`, `--flat`                                 |
| `tasks show <ref>`                                                                 | One task with its history and checkpoint results                                                                              |
| `tasks new "<title>" --group <g>`                                                  | Create in a group and assign a generated branch. An `--investigation` may supply the group instead.                           |
| `tasks edit <ref>`                                                                 | Change `--title`, `--desc`, `--priority`, `--status`, `--tag`, `--investigation`, `--group`, `--depends-on`, `--units`        |
| `tasks note <ref> <text>`                                                          | Append a note to the history                                                                                                  |
| `tasks group list`                                                                 | Every group, in the order the list draws them                                                                                 |
| `tasks group show <ref\|name>`                                                     | One group and everything in it                                                                                                |
| `tasks group new "<name>"`                                                         | Create one. `--desc`, `--color`, `--branch`                                                                                   |
| `tasks group edit <ref\|name>`                                                     | Change `--name`, `--desc`, `--color`, `--branch`                                                                              |
| `tasks group queue <ref\|name>`                                                    | What is left in it, in dependency order — what `/work-group` follows                                                          |
| `tasks group add <ref\|name> <task-ref>...`                                        | Put tasks in it                                                                                                               |
| `tasks group rm <ref\|name>`                                                       | Delete an empty group                                                                                                         |
| `tasks dep add <ref> <blocker-ref>...`                                             | Make the task wait for each blocker                                                                                           |
| `tasks dep rm <ref> <blocker-ref>...`                                              | Stop waiting for them                                                                                                         |
| `tasks dep list [<ref>]`                                                           | The dependency graph, or one task's corner of it                                                                              |
| `tasks move <ref> --top\|--bottom\|--up\|--down`                                   | Reorder the list                                                                                                              |
| `tasks move <ref> --before\|--after <ref>`                                         | Reorder relative to another task                                                                                              |
| `tasks branch <ref> [--from <branch>]`                                             | Create or switch to the task's assigned branch                                                                                |
| `tasks start\|done\|verify\|reopen <ref>`                                          | Move through the workflow (`start` requires the assigned branch; `done` merges into the group's branch, `--no-merge` to skip) |
| `tasks merge <ref>`                                                                | Merge the task into its group's branch and register it there                                                                  |
| `tasks checkpoint before\|after\|status <ref>`                                     | Drive aio-vr for one task                                                                                                     |
| `tasks checkpoint before <ref> --retro [--at <commit>] [--settle <s>] [--dry-run]` | Capture `before` at the commit the task started from                                                                          |
| `tasks baselines [--all]`                                                          | What has drifted from its approved baseline                                                                                   |
| `tasks baselines run [scenario...]`                                                | Re-run against the baselines                                                                                                  |
| `tasks baselines approve <scenario>`                                               | Accept the current capture as the new baseline                                                                                |
| `tasks web [--port n] [--dev]`                                                     | Serve the current Vue UI                                                                                                      |
| `tasks web --new [--port n] [--dev]`                                               | Serve the Solid 2.0 proof of concept                                                                                          |
| `tasks rm <ref>`                                                                   | Delete a task (the checkpoint on disk is left alone)                                                                          |

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

### Groups

A **group** is a named bundle of tasks — a feature, a release, or the output of
one investigation. A task is in **at most one** group, which is what separates a
group from a tag: tags stay free-form labels a task can carry any number of.

```bash
tasks group new "Search rework" --desc "Everything behind the new index"
tasks group add "Search rework" T-4 T-5     # by name or by ref (G-1)
tasks list                                  # drawn in sections
tasks list --group "Search rework"          # just that group
tasks list --flat                           # the bare queue, no sections
```

Both the task list and the **Plan** are drawn in those sections: the list gets a
collapsible heading per group, the Gantt chart gets a band per group with a bar
spanning that group's earliest task to its latest. Turn either off — **Group** in
the task list header, **Bands** on the plan — and you get the flat view back.

In `tasks web`, **drag a row onto a group's heading** to move it into that group,
or drop it among that group's rows to land in a particular place. `Alt+↑`/`Alt+↓`
does the same thing from the keyboard: nudging a row across a section boundary
moves it into that section. Tick several rows and use **Move to group…** to file
a batch at once. A task's group can also be changed from the picker in its detail
pane, and `tasks group add` does it from the CLI.

**Grouping does not reorder the queue behind your back — it keeps it readable.**
Sections are ordered by their first task in the queue, so the row at the top of
a grouped list is still the one `/work-task` picks up. Putting a task in a group
moves it beside that group's other tasks, which keeps a group contiguous and the
grouped list reading in queue order; that is the one queue change grouping makes,
and both the CLI and the UI say so when they do it. Taking a task _out_ of a
group leaves it where it is, so an ungrouped row can sit further down the queue
than the section above it — `tasks list` numbers every row with its actual place,
and `tasks list --flat` shows the queue with no sections at all.

#### A group is a branch

Every group has a **branch**, defaulted from its name (`group/g-1-search-rework`)
and changeable with `--branch` or the **Branch** field in the group dialog. That
branch is where the group's work adds up:

- `tasks branch T-4` cuts T-4's branch from its **group's** branch rather than
  from master, so a task starts with everything the group has finished so far.
- `tasks done T-4` merges T-4's branch back into the group branch with a merge
  commit, and **registers T-4 on it** — the group branch appears in the Branches
  view with its tasks listed, ready to raise as one PR.

The Git branch is created lazily, the first time a task in the group is
branched — filing tasks under a heading does not put branches in your
repository. A task in no group behaves exactly as before.

```bash
tasks group new "Search rework"       # branch: group/g-1-search-rework
tasks group add "Search rework" T-4 T-5
tasks branch T-4                      # cut from group/g-1-search-rework
tasks done T-4                        # merged back into it, and registered
tasks branch T-5                      # cut from it too, so it has T-4's work
```

#### The group page

Click **Open** on a group's heading in `tasks web` (or go to `/groups/G-1`, which
is a real, linkable route) for the group's own page: its description, its branch
and that branch's live Git state, the tasks on it, and the **work order** — the
group's unfinished tasks sorted so nothing comes before what it depends on. A
task waiting on something _outside_ the group is called out, because working the
group alone will never clear it.

`tasks group queue G-1` is the same order from the CLI, and `--json` is what an
agent reads.

Finished tasks are marked **✓ merged** or **not merged** against the group
branch, taken from the branch's own roster rather than guessed — a task that is
Dev Complete but not on the branch is the one thing you actually need to spot.

#### Next up

The group page names the task to work next: the first in the work order that
nothing unfinished is holding up. **Start** points an agent at just that one
(`/work-task T-4`), branched from the group's branch like any other.

It never launches anything by itself. The queue _advances_ on its own — the page
re-reads on every change, so finishing a task moves this on to the next — but
pressing the button is yours. That is deliberate: `tasks done` fires while the
agent is still reporting back, so auto-launching the next one would put two
agents in the same working tree, both switching branches.

For the same reason it applies `/work-task`'s own rule and refuses while any
task is in progress — including a task in **another group**, since the conflict
is the working tree, not the group. When the in-flight task _is_ the next one,
the button reads **Continue** instead: that is resuming, not starting a second.

#### Working a whole group with an agent

The group page has a **Work with Agent** button, which runs `/work-group G-1`.
It works every task in the queue order, branching each from the group's branch
and merging it back when it is done — `/work-task` in a loop, with the order
decided by `tasks group queue` rather than by the agent.

It stops and hands back rather than guessing when a merge conflicts, a
dependency outside the group is unmet, or a checkpoint fails. A stopped run
leaves the group partly delivered, which is a normal state: the tasks it did
finish are merged and registered.

`tasks done --no-merge` skips the merge when you want to review first;
`tasks merge T-4` does it afterwards. A merge that hits conflicts leaves them in
the working tree on the group branch — resolve them, commit, then
`tasks merge T-4` to register the task. Both are idempotent: a task already on
the branch is registered without a second merge.

A group containing tasks cannot be deleted. Move its tasks into another group
first; this keeps the mandatory membership invariant intact.

#### Tasks from an investigation are grouped automatically

Filing a task with `--investigation I-3` — which is what `/plan-tasks` does for
every task it files — puts it in a group for that investigation, creating the
group on the first task if it is not there yet. A run of `/plan-tasks` therefore
arrives as one bundle you can collapse, filter and read as a unit rather than as
eight loose rows in the backlog.

The group is keyed on the investigation, not on its name, so renaming the group
or re-running the same investigation refills the one that exists.

Tasks filed before groups existed stay visible in the read-only **Ungrouped**
compatibility group — nothing regroups them behind your back, but new tasks
cannot be added there. To organise a backlog that predates groups, make the groups and fill them:
`tasks group new "<investigation title>"` then `tasks group add <G-n> <refs...>`,
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

### The plan

**Plan** in the rail draws every task as a bar on a shared axis, the way a Gantt
chart does — except the axis is **units**, not dates. One unit is one task's
worth of work; most tasks are one unit, and `--units` (or the stepper on the
chart, or the field in the task editor) says when something is bigger. Nothing
here is an hour, a day or a calendar: the plan says what order the work can
happen in and how long the chain is, not when any of it lands.

Start times are not stored. Every dependency is finish-to-start with no lag, so
a task starts at the latest finish among its blockers, and a task waiting on
nothing starts at unit 1. That is computed in the browser out of Vue's own
reactivity — one `computed` per task, each reading its blockers' — so changing
one estimate re-lays out exactly the tasks downstream of it and leaves the rest
of the plan cached. Stepping an estimate up or down on the chart redraws the
whole downstream chain before the write to the server has even finished.

Groups become **bands**: each group gets a heading row with a thin bar spanning
its earliest task to its latest, and its tasks sit under it carrying the group's
colour. Filter to one group, or switch the bands off, from the toolbar.

Closed tasks are off the plan unless you ask for them, and a dependency pointing
at a task the plan is not showing is **ignored rather than assumed** — same rule
the blocked markers in the list follow. A dashed link means the blocker is not
finished yet; a solid one means the work it needs already exists.

There is no lag, no "start no earlier than", and no non-working time. A cycle
cannot normally exist (the server refuses to create one), and if one somehow
does, the plan drops the edge that closes it rather than hanging.

### Prepare and combine task branches (web UI)

A **Verified** task can be closed from its detail view with **Clean checkpoint & close**. This runs `aio-vr clean --name <task-checkpoint>` first; only a successful cleanup marks the task **Closed**. Closed tasks are omitted from the normal list but remain available through an explicit status query/API request.

In `tasks web`, tick two or more **Dev Complete** or **Verified** tasks, enter the
new combined branch name, and select **Combine branches**. The server requires a
clean working tree and always cuts the combined branch from the **base branch**
(`baseBranch` in `tasks.config.json`, otherwise the repository's default branch)
— never from whatever is checked out, so it does not matter which branch you are
on when you start. The base is fetched and fast-forwarded to `origin` first, so
the work lands on top of current `master` rather than on whatever was there the
last time anyone pulled. If the base cannot be fetched, or has diverged from
`origin` (commits on each side), the combine stops rather than build on a stale
or ambiguous base; a base that is merely _ahead_ of `origin` is used as-is, with
the unpushed commits riding along.

Each selected task branch's commits are then cherry-picked in task-list order —
its complete range since it forked from the base, the same range the PR will
show — producing a normal linear branch. This is intentionally not a rebase or
merge: a cherry-pick-based copy is directly portable to another repository.
Ranges are resolved before the branch is created, so a task with nothing to pick
fails without leaving a stray branch behind. The review screen lists those
commits — subject line and short SHA, per task, in pick order — so what you are
about to build is visible before you build it; a task with nothing to pick is
called out there rather than after the click. Resolve any reported cherry-pick
conflict on the newly-created branch before retrying. **Close tasks** is checked by default. When checked,
every selected task must be Verified; after all cherry-picks succeed, each
checkpoint is cleaned and its task is closed.

Ticking exactly one task offers **Review & prepare branch** instead. It is the
same operation under different wording: the task's commit range is cherry-picked
onto a new branch under whatever name you want on the PR, and the result is an
ordinary delivery branch with the same description, target-branch and
pull-request controls as a combined one. Use it when a single task's generated
branch name is not the name you want the PR to carry.

### Branches

Every newly created task is assigned a Git-valid branch name, generated as
`<branchPrefix>t-<n>-<title-slug>` unless `--branch` supplies an override. Use
`tasks branch <ref>` to create or switch to it; `tasks start` refuses to begin
work from another branch. Existing `backlog` and `in_progress` tasks are
backfilled when the database is first opened. Historical completed tasks are
left unassigned.

A new branch is cut from the task's **group branch** when it has one (see
[A group is a branch](#a-group-is-a-branch)), otherwise from the branch of a
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
tasks group list --json                # the groups, and how much is in each
tasks group add "Search rework" T-4    # put a task in one (by name or ref)
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
  tasks it files land in a [group](#groups) for that investigation automatically,
  so a run arrives as one bundle rather than as loose rows. It also judges each
  task's `fast`/`standard`/`frontier` tier — how much model capability the work
  looks like it needs — which becomes the model dropdown's starting value on a
  `work-task` run, resolved through `modelTiers` in `tasks.config.json`.
- **`/work-task [ref]`** — drives one task through the whole workflow: branch →
  `checkpoint before` → make the change → `checkpoint after` → `tasks done`.
  With no ref it takes the task at the top of the list. It stops rather than
  starting a second task when one is already `in_progress`, and stops to ask when
  the task is waiting on a [dependency](#dependencies) that is not finished. It
  branches from the task's [group branch](#a-group-is-a-branch) when it has one,
  otherwise from a finished dependency's branch, otherwise from the base — and
  reports which. It also owns the **scenario coverage** of its own change: if the
  task moves something a user can see, a scenario has to show it. One is written
  before the `before` capture when nothing covers the state yet, and when the
  `after` comes back `unchanged` on work that was meant to be visible, the
  scenario is added or extended and the before state recaptured with
  [`--retro`](#capturing-before-after-the-fact).
- **`/work-group <G-n>`** — the same thing for a whole [group](#groups), one task
  at a time, in the order `tasks group queue` gives. Each task is branched from
  the group's branch and merged back into it, so the run leaves one reviewable
  branch. It requires a ref — a group is a commitment to a branch, and guessing
  which one is not something the user recovers from by noticing later. It stops
  and hands back on a merge conflict, on a dependency outside the group, or on a
  failed checkpoint, leaving the tasks it did finish merged and registered.

The natural pairing is `/plan-tasks` to fill the backlog, then `/work-task` or
`/work-group` to empty it. All three can also be fired from the web UI against
whatever is on screen — see
[Running an agent from the UI](#running-an-agent-from-the-ui).

`--json` on a capture suppresses aio-vr's progress output and returns a single
JSON document: the run, its per-scenario comparisons, and the updated task.
`tasks done --json` also carries a `captureError` field — the transition still
happens if the capture fails, so this is how you find out that it did.

## Running an agent from the UI

Every command can be fired from the web UI rather than typed into a terminal,
against whatever is on screen:

| Where                       | Button              | What it runs       |
| --------------------------- | ------------------- | ------------------ |
| Issues → an open issue      | **Investigate**     | `/plan-tasks #677` |
| Investigations → **Run it** | **Run it here**     | `/plan-tasks I-3`  |
| Tasks → a selected task     | **Work with agent** | `/work-task T-12`  |
| A group's page              | **Work with Agent** | `/work-group G-1`  |

Every resumable run records a **session id**, so **Resume** on a run — the one on screen, or any
in the run history — opens a new terminal window on that same conversation
(`claude --resume <id>`, `codex resume <id>`, `pi --session-id <id>`). It does not start a new run;
it is the same session, opened again, so the history does not claim the agent
was launched twice. Claude Code and pi accept an id generated at launch. Codex
generates its own; headless runs capture the id from its startup output, while
interactive Codex runs cannot expose it to this server and show Resume disabled.

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

**Sync** fetches the notes repository and fast-forwards onto what came back —
the "go and get what everyone else wrote" action. It is deliberately
fast-forward only: a merge that stopped half-done would leave the notes folder
conflicted with no way to resolve it from this UI, so a genuinely diverged
repository is reported and left untouched for you to reconcile in a terminal.
It does not commit first either — the Commit button beside it does that, and
quietly committing a half-written note because you asked to pull would be a
surprise. Uncommitted edits that the incoming commits would overwrite make Git
refuse the fast-forward, and it says which files.

The same **Sync** button appears in the Issues view, because it is the same
folder and the same pull; see below.

Fetching and pushing are the only operations here that talk to a network, and
neither is automatic.

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

The Issues view reads every `.json` file in the notes folder, recognises the ones
that describe an issue, and shows them as cards. **Nothing here talks to an issue
tracker.** Whatever produces the files — `gh issue view --json`, a script, an
agent — is somebody else's job; this view is a reader, and the files are re-read
on every request, so replacing one and switching back to the tab is the whole
refresh story.

The one network action is **Sync** in the sidebar: it fetches and fast-forwards
the notes repository, which is where the issue files live, so issues somebody
else committed appear without leaving the view. It is the same button, and the
same pull, as the one in the Notes view — see [Git](#git) above for exactly what
it will and will not do.

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

Adding a provider is a `fromX()` adapter in `src/server/issues.ts`, a line in
`ISSUE_SOURCE_LABELS`, and a colour for `.issue-card.source-x` in the stylesheet.
The view, the filters and the card need no changes.

## Web UI

```bash
tasks web               # current Vue build on the configured apiPort
tasks web --new         # Solid 2.0 + Tailwind proof of concept
tasks web --dev         # Vue Vite dev server on webPort, API on apiPort
tasks web --new --dev   # Solid Vite dev server on webPort, API on apiPort
```

The two frontends have separate source and output directories, but use the same
API and workspace. The Solid 2.0 prerelease references used by the new UI are
vendored in [`docs/solid-2.0`](docs/solid-2.0/README.md); agents should begin
with its migration guide before extending the proof of concept.

The rail on the far left switches between **Investigations**, **Tasks**,
**Plan**, **Branches**, **Baselines**, **Notes** and **Issues**. Investigations come first because that is
where work starts: write the brief, run `/plan-tasks` against it, and the tasks it
produced appear underneath it.

**Tasks** is the queue, drawn in [group](#groups) sections with a collapsible
heading each. Drag a row onto a heading to move it into that group, or among a
group's rows to place it exactly; the **Group** switch in the header turns the
sections off without changing anything about the tasks. **New group** creates
one, and a heading's **Edit** renames, recolours or deletes it.

**Plan** takes the whole window — it is a chart, not a record — and is described
under [The plan](#the-plan). Clicking any bar opens that task. Groups are drawn
there as bands.

**Baselines** takes the whole window too, and is described under
[Baselines](#baselines). The rail badges the number of scenarios that have
drifted, so it is visible from every other view.

**Issues** is a board rather than a list: the filters (search, state, source,
label) are on the left and the cards take the whole pane, with a click opening
one full-screen and a **← All issues** button coming back. An open issue has an
**Investigate** button that points an agent at it — see
[Running an agent from the UI](#running-an-agent-from-the-ui). See also
[Issues](#issues).

The Notes screen is a Markdown editor with a live preview (**Write** / **Split** /
**Read**). Images pasted or dropped into the editor are uploaded, stored beside
the note and linked at the caret. Everything it writes goes to the file system,
not the database — the list is re-read each time the view is opened, because the
CLI, an agent or a `git pull` may have changed the folder behind the tab's back.

### The page keeps up with the workspace

The CLI, an agent and this app all write to the same workspace, so the tab is
routinely looking at data another process has just replaced. It follows along:
`tasks done T-1` in a terminal, a `/work-task` run moving a task to Dev
Complete, or a `git pull` in the notes folder all show up in an open page
without touching it.

The server watches the two stores — the database directory (WAL and all) and
the notes folder — and streams _which one moved_ over
`GET /api/events` (Server-Sent Events). No data travels on that stream: the
client already knows how to load every view it can show, and what it lacked was
any way to know it should. So a change reloads the two list columns, whatever
record is selected, and the current view's own data, through exactly the same
calls a click would have made.

Unsaved typing is never overwritten. The brief, a note's body and a PR
description each keep what you have typed over an incoming version, and a reorder
in progress is left alone until the drag ends.

The stream reconnects itself, and tells the client where each channel stands
when it does, so anything that happened while a laptop was asleep is caught up
on rather than missed. A dot appears at the foot of the left rail when live
updates are **not** working — a page that quietly stopped following the
workspace otherwise looks exactly like one where nothing has happened. Views
still reload on navigation regardless, which is what an older server (or a
filesystem with no change notifications) falls back to.

Prose is rendered as the Markdown it was written in — an investigation's brief
and findings, a task's description, an issue body, a generated PR description —
with a **Copy** button that hands back the Markdown source rather than the
rendered text. The two blocks that are also editing surfaces, the brief and the
PR body, carry a **Write** / **Read** toggle; Read previews what you have typed,
not what was last saved.

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

- **Two roots, deliberately.** The _package_ is where the tool is installed —
  the server entry point, the built SPA. The _workspace_ is the `.tasks/` folder
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
  to in SQLite or in a folder of Markdown, so `src/server/watch.ts` watches what
  they actually are — files — and says "the database moved" or "the notes folder
  moved". Sending the new state down that stream would mean a second definition
  of what each view needs, in parallel with the one the views already have, and
  one of the two would rot. Writes made through the server announce themselves
  directly as well, so live updates still work on a filesystem whose change
  notifications do not.
- **A group is one column on the task, not a join table.** A task belongs to at
  most one group, so expressing membership as a nullable `group_ref` makes that a
  fact of the schema rather than a rule something has to enforce — and grouping
  stays one write, which is what lets a drag change a row's group and its place
  in the queue in one gesture. The ref is plain rather than a foreign key, the
  same as an investigation's: deleting the grouping must never delete the work.
  Both views section the list through one shared function (`groupTasks`), so the
  list and the plan cannot disagree about what the grouping is.
- **Notes go the other way on purpose.** Workflow state — statuses, transitions,
  queue order — is what a database is for. Prose is not: it wants to be a file
  somebody else's tools can open, and a history somebody else's clone can pull.
  So notes are files, their folder is a repository, and this tool is one of
  several ways to write them rather than the only one.
- Issues are **read-only and provider-shaped at the edge**. One adapter per
  provider flattens a file into a common card; everything downstream of that —
  the board, the filters, the detail view — knows nothing about GitHub or Azure
  DevOps. That is what stops the second provider being a rewrite of the first.
- The Markdown preview is rendered by a small renderer in `src/web/markdown.ts`
  rather than a dependency. It escapes the source before any rule runs, so the
  only markup in the output is the markup it emits — which is what makes it safe
  to preview a note written by an agent or pulled from someone else's clone.
  Everything that displays stored prose goes through it (`MarkdownBlock.vue`):
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
