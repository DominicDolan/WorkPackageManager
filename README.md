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
- an agent CLI — `claude` and/or `pi`, for PR descriptions and for running
  investigations and tasks from the UI. A terminal emulator too, if you want
  those runs to open a window you can talk to

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
| `agentTerminal` | `null` | Command that opens a terminal window, with the agent's argv appended. `null` autodetects |

`prAgent` is a command plus its flags; the prompt is appended as one final
argument. Whatever you configure wants the equivalent of `--no-tools`: the
command is fired from a web request, so a tool-enabled agent could block on an
approval prompt with nobody at the terminal to answer it, and could touch the
working tree while you are mid-combine.

`agentTerminal` is how "open a window with the agent running in it" is spelled,
and every emulator spells it differently — `["kitty","--hold"]`,
`["gnome-terminal","--"]`, `["wezterm","start","--"]`. The agent's own argv is
appended to it. Left `null`, the first of kitty, wezterm, ghostty, konsole,
alacritty, gnome-terminal, foot and xterm found on PATH is used; set it
explicitly to pin one or to pass it extra flags.

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
| `tasks new "<title>"` | Create; assigns a generated branch. `--branch`, `--desc`, `--priority`, `--tag`, `--investigation`, `--depends-on`, `--units` |
| `tasks edit <ref>` | Change `--title`, `--desc`, `--priority`, `--status`, `--tag`, `--investigation`, `--depends-on`, `--units` |
| `tasks note <ref> <text>` | Append a note to the history |
| `tasks dep add <ref> <blocker-ref>...` | Make the task wait for each blocker |
| `tasks dep rm <ref> <blocker-ref>...` | Stop waiting for them |
| `tasks dep list [<ref>]` | The dependency graph, or one task's corner of it |
| `tasks move <ref> --top\|--bottom\|--up\|--down` | Reorder the list |
| `tasks move <ref> --before\|--after <ref>` | Reorder relative to another task |
| `tasks branch <ref> [--from <branch>]` | Create or switch to the task's assigned branch |
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

### Dependencies

A task can wait for other tasks: `tasks dep add T-4 T-2` records that T-4 needs
T-2 first. In the web UI the same thing is done from a task's **Dependencies**
section — pick a task from the list to wait for, or remove one — and that
section also shows what is waiting on *this* task.

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
or ambiguous base; a base that is merely *ahead* of `origin` is used as-is, with
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

### For agents

```bash
tasks investigation list --json        # what is waiting to be investigated
tasks investigation show I-1 --json    # the brief to work from
tasks list --json                      # the queue, top first
tasks list --status in_progress --json # is something already being worked?
tasks show T-1 --json                  # full detail incl. per-scenario results
tasks dep list --json                  # the dependency graph, with what is blocked
tasks dep add T-4 T-2                  # T-4 waits for T-2
tasks notes list --json                # what has been written down
tasks notes show <path> --raw          # the Markdown body, nothing else
tasks issues list --json               # every issue fetched into the notes folder
tasks issues show 677 --json           # one issue in full, body included
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
  waiting to be run. When the brief names an issue (`#677`, an issue URL, a work
  item), it reads that issue first — see [Issues](#issues). Where a split leaves
  a real ordering — the API cannot be written before its schema — it records that
  as a [dependency](#dependencies) rather than a sentence in a description.
- **`/work-task [ref]`** — drives one task through the whole workflow: branch
  from the base branch → `checkpoint before` → make the change →
  `checkpoint after` → `tasks done`. With no ref it takes the task at the top of
  the list. It stops rather than starting a second task when one is already
  `in_progress`, and stops to ask when the task is waiting on a
  [dependency](#dependencies) that is not finished. When the dependency *is*
  finished it branches from that task's branch instead of the base, since that
  is the only place the dependency's work exists yet.

The natural pairing is `/plan-tasks` to fill the backlog, then `/work-task` to
empty it. Both can also be fired from the web UI against whatever is on screen —
see [Running an agent from the UI](#running-an-agent-from-the-ui).

`--json` on a capture suppresses aio-vr's progress output and returns a single
JSON document: the run, its per-scenario comparisons, and the updated task.
`tasks done --json` also carries a `captureError` field — the transition still
happens if the capture fails, so this is how you find out that it did.

## Running an agent from the UI

Both slash commands can be fired from the web UI rather than typed into a
terminal, against whatever is on screen:

| Where | Button | What it runs |
|---|---|---|
| Issues → an open issue | **Investigate** | `/plan-tasks #677` |
| Investigations → **Run it** | **Run it here** | `/plan-tasks I-3` |
| Tasks → a selected task | **Work with agent** | `/work-task T-12` |

The dialog takes an optional extra prompt, the harness (**Claude Code** or
**pi**, whichever is on PATH) and the model. Claude Code cannot list its own
models, so it offers the tier aliases — `opus`, `sonnet`, `fable`, `haiku` —
which track the current model of each tier. `pi` is asked for its catalogue with
`pi --list-models` and offers all of it, grouped by provider. Either can be left
on its own default.

The extra prompt goes *below* the command, so the command still gets its ref as
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

Claude Code's permission mode is a property of the session, not of how it was
launched, so the dialog offers it for **both** ways of running. `pi` has no
equivalent and the control is hidden for it.

| Choice | Flag | What it means |
| --- | --- | --- |
| Ask every time | *(none passed)* | Claude's own default: it asks before each edit and each command. |
| **Auto** | `--permission-mode auto` | Edits and safe commands go through unasked; risky ones still stop to ask. The mode Shift+Tab reaches inside the terminal UI — this just starts there. |
| Plan only | `--permission-mode plan` | Reads and proposes, changes nothing. |
| Never ask | `--permission-mode bypassPermissions` | Asks about nothing at all. |

"Ask every time" is the one mode expressed by passing *no* flag rather than by
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
tasks notes rm <path>
tasks notes sync [--push]
tasks notes status
```

`--body -` and `--append -` read from stdin, which is how an agent writes a long
note without quoting it. `tasks notes <path>` is shorthand for `show`.

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
tasks web           # serves the bundled build on the configured apiPort
tasks web --dev     # Vite dev server on webPort, API on apiPort
```

The rail on the far left switches between **Investigations**, **Tasks**,
**Plan**, **Branches**, **Notes** and **Issues**. Investigations come first because that is
where work starts: write the brief, run `/plan-tasks` against it, and the tasks it
produced appear underneath it.

**Plan** takes the whole window — it is a chart, not a record — and is described
under [The plan](#the-plan). Clicking any bar opens that task.

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
the notes folder — and streams *which one moved* over
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
- **Live updates carry no data, only a channel.** There is nothing to subscribe
  to in SQLite or in a folder of Markdown, so `src/server/watch.ts` watches what
  they actually are — files — and says "the database moved" or "the notes folder
  moved". Sending the new state down that stream would mean a second definition
  of what each view needs, in parallel with the one the views already have, and
  one of the two would rot. Writes made through the server announce themselves
  directly as well, so live updates still work on a filesystem whose change
  notifications do not.
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
  Markdown. **Copy** on such a block copies the *source*, because the reason to
  copy any of it is to paste it somewhere that wants the Markdown back.

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
