Run an investigation that has already been written down, and turn what you find
into tasks linked back to it.

Investigation ref (may be empty): `$1`

**This command does not change code.** Investigate, file tasks, write the
findings back. The actual work happens later, via a `work-task` run.

> `tasks` should be on PATH — it is the globally installed `work-task-manager`
> CLI. If it is not, say so and stop; there is no in-repo copy to fall back to.
> A repository with no `.tasks/` workspace needs `tasks init` first.

## 0. Pick the investigation

```bash
tasks investigation list --json
```

- **A ref was given** — use it.
- **No ref, exactly one** investigation is `draft` or `investigating` — use that
  one and say which you picked.
- **No ref, several** — list them as `ref — title (status)` and ask which. Do not
  guess.
- **No ref, none at all** — say so and stop. The investigation is written in the
  Investigations view of `tasks web` first; that is the point of this command.

If `$1` is free text rather than a ref (`I-<n>`), the user is asking for
something that was never written down. Offer to record it first, then run it:

```bash
tasks investigation new "<title>" --brief - <<'EOF'
<their text>
EOF
```

Then read the brief in full — it is the human's actual request, and everything
below is in service of it:

```bash
tasks investigation show I-<n> --json
```

Mark it as being worked on before you start, so anyone looking at the UI can see
it is in flight:

```bash
tasks investigation start I-<n>
```

### If an issue is mentioned, read it first

The brief — or `$1` itself — may point at a tracked issue: `#677`, an issue URL,
or an Azure DevOps work item. Issues are fetched into the notes folder as JSON
and read back through the CLI:

```bash
tasks issues list --json        # everything that has been fetched
tasks issues show 677 --json    # one of them in full, body included
```

Read it **before** investigating. The reporter's steps, the expected-versus-actual
and the labels are the actual request; a brief that names an issue is usually
just a pointer to it, and investigating from the pointer alone means answering
the wrong question.

If the brief names an issue that `tasks issues show` cannot find, say so and ask.
Do not go and fetch it yourself, and do not guess at what it said — this command
reads the files that are there.

Carry the reference into the tasks you file, in the title or the description, so
whoever picks one up can get back to the original report.

## 1. Understand what already exists

Before investigating, look at what is already tracked so you do not file
duplicates:

```bash
tasks list --json
```

Read the titles and descriptions. If something you are about to file already
exists, note it and skip it rather than creating a near-duplicate.

## 2. Investigate

Do the actual investigation the brief asks for. Read the code — do not speculate
from file names. Ground every finding in something you actually read.

Useful context for this repo lives in `CLAUDE.md`, `backend-modular/CLAUDE.md`
and `docs/`. Check them before concluding that something is undocumented or
missing.

Work out, for each thing you find:

- **What is actually wrong or missing**, and the evidence — file and line.
- **Why it matters.** If you cannot say what breaks or who it affects, it is
  probably not worth filing.
- **Roughly what fixing it involves.** You do not need a full design, but the
  task should not start from zero.
- **Roughly how much model capability it needs** — see the tier note in step 4.

Say so plainly if the investigation finds nothing worth filing. An honest "the
code already handles this, here is where" is a good outcome, and it still belongs
in the findings. Do not manufacture tasks to look productive.

## 3. Decide what is actually a task

A good task is **independently completable** — someone can pick it up, finish it,
and mark it dev complete without holding another task open.

- Merge trivia into one task rather than filing five one-line tasks.
- Split anything that would touch several unrelated areas.
- Do not file a task for something you can confirm is already correct.

### When one task genuinely has to come after another

Splitting sometimes leaves an order that is real: the API cannot be written
before the schema it reads. That order gets **recorded** rather than left in a
description for someone to notice — `--depends-on` when filing, or
`tasks dep add <ref> <blocker-ref>` afterwards.

It matters beyond the reading order: a `work-task` run stops and asks before
starting a task whose dependency is unfinished, and when the dependency _is_
finished it cuts the new branch from that task's branch instead of from master,
so the work is written against code that actually exists.

Use it sparingly, and only for a real ordering:

- **Yes** — the second task cannot be built or verified until the first exists.
- **No** — they merely touch the same file, or you happen to think one is more
  important. That is priority and list order, not a dependency.
- Prefer a **chain** (A → B → C) over making everything depend on one task. A
  fan of dependencies off a single task blocks the whole batch on it.
- Do not create a cycle; it is refused anyway, and it would mean nothing in the
  loop could ever be started.

If you find yourself giving nearly every task a dependency, the split is wrong —
those are one task.

**Before creating anything, list the tasks you intend to file** — title,
priority, tier, a one-line reason each, and **any dependency between them** — so
the user can see the shape of it, and the order, before it exists.

If you have more than **8** tasks, file the most important 8 and ask the user
before filing the rest. A wall of new tasks is worse than a focused list.

## 4. File them

Every task gets `--investigation`, so the Investigations view shows what came out
of the question. That also files it in the investigation's work package, on that
work package's newest branch — do not pass `--work-package` as well:

```bash
tasks new "<title>" --investigation I-<n> \
  --priority <low|medium|high> --tier <fast|standard|frontier> --tag <tag> --desc "<description>"
```

File them in dependency order — a blocker has to exist before anything can be
pointed at it — and add `--depends-on <ref>` (repeatable) to the ones that wait:

```bash
tasks new "Add the migration" --investigation I-3 --priority high --tier standard
# → T-12
tasks new "Read the new column in the API" --investigation I-3 \
  --priority medium --tier fast --depends-on T-12
```

`tasks dep add T-13 T-12` records the same thing after the fact, and
`tasks dep list` shows the graph you have built. Check it before you report.

**Title** — the outcome, not the symptom. "Debounce the gantt resize handler"
beats "gantt is slow".

**Priority:**

|          |                                                                  |
| -------- | ---------------------------------------------------------------- |
| `high`   | Broken, data-losing, blocking someone, or user-visible and wrong |
| `medium` | Real problem, no one is blocked right now — the default          |
| `low`    | Worth doing, nothing breaks if it waits                          |

**Tier** — your judgement of how much model capability whoever picks this up
will need. This is the whole point of setting it: the person running the task
later sees your recommendation and can accept or override it. Judge it by the
_shape_ of the work, not by how important it is — a `high`-priority task can
still be mechanical, and a `low`-priority one can still be genuinely hard.

Prefer `fast` whenever the work can reasonably start with a fast model. This
workspace's task workflow can escalate a fast run to a more capable model when
the fast model cannot complete the work, so do not predictively choose
`frontier` just because the task might be difficult. Use `standard` or
`frontier` only when the task's known requirements justify starting at that
capability level and the escalation path would be inadequate or wasteful.

|            |                                                                                                                                                                             |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fast`     | Default when the task is bounded and can reasonably be attempted by a fast model; this includes most normal, well-scoped changes, since the workflow can escalate if needed |
| `standard` | Start here only when the task's known complexity makes a fast attempt likely to waste time and escalation would not handle that efficiently                                 |
| `frontier` | Reserve for work with clear, substantial ambiguity or subtle cross-system interactions where starting with a fast model and escalating would be inadequate                  |

Leave it unset (omit `--tier`) only when you genuinely cannot judge — not as a
default. When unsure, choose `fast` so the escalation path can handle a task
that proves more demanding than expected.

**Tags** — reuse what is already in `tasks list --json` before inventing new
ones. `--tag` repeats: `--tag frontend --tag gantt`.

**Description** — this is the part that matters. Whoever picks the task up
should not have to redo your investigation. Task agents are intentionally run
with a low thinking effort: treat the description and notes as their handoff,
not a place to make them rediscover work you already did. Include:

- the specific files and lines involved
- what you found, and why it needs changing
- the suggested approach, and anything you ruled out and why
- how to tell it worked — including which aio-vr scenario would show it, if the
  change is visual. Name an existing scenario when one already reaches the state
  that will move; when nothing does, say so and say what the new scenario has to
  reach (the page, and the dialog or tab or filtered state within it). The task
  agent has to write that scenario before it captures its "before", so telling it
  what to cover is part of the handoff.

Use task notes for supporting investigation details that do not fit cleanly in
the description: relevant command output, code excerpts, links, decisions, and
open caveats. Make each note actionable and say what it implies; do not leave a
future task agent to interpret an unexplained dump.

Descriptions can be multi-line; quote them and they come through intact:

```bash
tasks new "Debounce the gantt resize handler" --investigation I-3 \
  --priority high --tier standard --tag frontend --tag gantt \
  --desc "GanttChart.vue:212 recomputes every bar on each resize event, so
dragging the window edge re-lays out ~400 rows per frame.

Approach: debounce to ~100ms, or move the layout into a ResizeObserver.
Ruled out: virtualising the rows — too big a change for this problem.

Verify: tasks checkpoint before/after with --scenario plan.gantt."
```

Tasks default to the normal branch/commit/merge workflow. When a task changes
only ignored or local workspace files—for example adding an `.aio-vr/scenarios/`
scenario—create it with `--no-git`. Do not use `--no-git` for product-code
changes merely to avoid branching; it is specifically for work that should not
be committed.

Capture a finding as a task even when it is outside what the brief asked for —
that is the point of filing rather than fixing. Keep it in its own task, do not
fold it into an unrelated one.

## 5. Write the findings back, and close the investigation

The findings are what stops the next person repeating your work, so this step is
not optional. `--findings -` reads stdin, which is how multi-line Markdown gets
in cleanly:

```bash
tasks investigation complete I-<n> --findings - <<'EOF'
What I looked at, and what I concluded — the reasoning, not a task list.

Include what you ruled out and why, and anything you could not determine along
with what would settle it. Reference files and lines.

Filed: T-12, T-13. Not filed: <thing> — <why>.
EOF
```

Leave it as `investigating` rather than `complete` only if you genuinely could
not finish — say so, and put what you have into `--findings` with
`tasks investigation edit I-<n> --findings -`.

## 6. Report

Tell the user:

- which investigation you ran, what you concluded — the findings, not just a
  task count
- the tasks you created, as `ref — title (priority, tier)`, noting any that wait
  for another (`T-13 — … (medium, standard, after T-12)`) and which one can be
  started now
- anything you found but deliberately did **not** file, and why
- anything you could not determine, and what would settle it

Then point at the next step:

```bash
tasks list          # review
```

Pick a task up next with a `work-task` run (the "Work" button in `tasks web`),
targeting the top of the list or a specific ref.

If the user disagrees with the set, `tasks rm <ref>` removes one and
`tasks edit <ref>` adjusts it — nothing here is expensive to undo.
