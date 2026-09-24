Work every unfinished task in one **work package**, in an order that respects their
dependencies, leaving each one Dev Complete. Tasks with `useGitWorkflow: true`
are merged into each of their target branches; no-Git tasks deliberately are not.

Work package (may be empty): `$1`

This command is a loop around the `work-task` procedure, appended in full below
this file. It does not replace it: each task is worked by the same steps, with
the same checkpoint discipline. What this adds is the order, the work package's
branches, and knowing when to stop.

## 0. Resolve the work package

```bash
tasks work-package queue $1 --json
```

If `$1` is empty, **stop and ask** which work package. Do not pick one — a work package is a
commitment to a branch, and guessing which one is not recoverable by the user
noticing later.

That command returns the work package (including its `branches`) and `queue`: the
unfinished tasks already sorted so nothing comes before what it depends on.
Each queued task carries `targetBranches` — the work package branches its work
has to land on, the one it is cut from first. A work package can deliver
through several branches, and a task is usually on exactly one of them.
**That order is the answer.** Do not re-derive it, and do not reorder it because
something looks easier.

If the queue is empty, say so and stop — everything in the work package is already Dev
Complete or beyond.

## 1. Check what the work package cannot clear itself

Each queue entry carries `blockedBy` and `blockedByOutside`.

- `blockedByOutside` is non-empty → that task waits on work **outside this
  work package**, which this run will never do. **Stop before starting** and tell the
  user which tasks and which blockers, and offer their options: work the blocker
  first (a `work-task` run targeting it), drop the dependency
  (`tasks dep rm <ref> <blocker-ref>`), or say to proceed anyway and have those
  tasks worked while blocked.
- `blockedBy` containing only refs from inside the work package is **fine** — the queue
  order clears them as it goes.

## 2. Check the preconditions once

Do this once for the whole run, not per task:

- If any queued task has `useGitWorkflow: true`, the working tree is clean
  (`git status --short`) and run `git fetch origin`. If it is dirty, ask rather
  than sweeping the user's changes onto a branch.
- If every queued task has `useGitWorkflow: false`, do neither Git check: those
  tasks work in ignored/local files on the current checkout.
- Whatever the `work-task` procedure's step 2 requires of this repository — the
  frontend being up for checkpoint capture, and anything else it names. If that
  is not satisfied, stop and say so. Do not silently skip checkpoints for a
  whole work package; that is a lot of evidence to quietly not collect.

Also confirm nothing else is mid-flight:

```bash
tasks list --status in_progress --json
```

If a task is already in progress and it is **not** the first entry in this
work package's queue, stop and warn — same rule as the `work-task` procedure's step 0,
and for the same reason.

## 3. Work each task, in queue order

For each task in `queue`, follow the **`work-task` procedure appended below**,
from its step 1a onwards — dependency check, branch, start, before-checkpoint,
the change, after-checkpoint, commit, `tasks done`. Follow it in full; do not
improvise a shorter version of it.

That includes its **scenario coverage** rule, per task: if a task changes what a
user sees, a scenario has to show it — written before the before-capture, or
added afterwards and the before state recaptured with
`tasks checkpoint before <ref> --retro`. A long run is exactly where this gets
quietly dropped, and a work package delivered with no evidence for half its tasks is
the thing this workflow exists to prevent.

Three things are specific to working inside a work package:

For a task with `useGitWorkflow: false`, skip all branching, committing, and
merging described below. Work in the current checkout and let `tasks done` only
capture and change status.

For a task with `useGitWorkflow: true`, **the branch comes from the task's first
target branch, not from master.** `tasks branch <ref>` picks the start point
itself, so still just run:

```bash
tasks branch <ref>
```

It prints what it branched from. Read that line. If it says anything other than
the first of the task's `targetBranches`, **stop and report it** rather than
carrying on — it means the branch is not where you think it is. A task with no
target branches is cut from the base branch; say so in your report, because its
work will not be merged anywhere.

For a Git-workflow task, **`tasks done` merges the task into every one of its
target branches** and registers it on each, then returns you to the task's
branch. Read its output:

- one `merged into <branch>` (or `already on <branch>`) line for **each** of the
  task's `targetBranches` — good, carry on to the next task.
- A conflict on any of them — the task's commits do not replay onto that branch.
  It aborts and changes nothing on it. **Stop the whole run.** Do not resolve a
  collision between two of the user's tasks on your own judgement. Report which
  branch and which two pieces of work collided and leave it for them.

It rebases before it fast-forwards, which is what keeps each work package branch a
straight run of commits rather than a chain of merges. **Do not undo that with a
merge of your own.** A merge commit anywhere on a work package branch cannot be
cherry-picked, and downstream copies of the branch are cherry-picks — so one
`git merge` here breaks the copy of every task on the branch, not just yours.
That includes bringing the base branch in: if a work package branch needs `master`,
that is `git rebase origin/master <that branch>`, it needs a force-push if the
branch is pushed, and it is the user's call. Stop and ask.

**Re-read the queue between tasks.** Working a task changes what is unblocked,
and the user may have edited the work package meanwhile:

```bash
tasks work-package queue <work-package-ref> --json
```

Take the first entry that is not yet `dev_complete`. This is also how you notice
a task that was added to the work package while you were working.

## 4. Stop early rather than pushing through

Stop the run and report where you got to if any of these happen. None of them
are yours to decide:

- a collision on `tasks done`, or a Git-workflow task branch it refuses to replay
- a checkpoint scenario that reports `failed`
- a task whose description turns out to need a decision the user has not made
- `tasks branch` starting from somewhere unexpected
- anything that would need a force-push, a rebase, or a change to master

Tasks already finished stay finished — a stopped run leaves the work package partly
delivered, which is the normal and recoverable state, not a mess to tidy up.

## 5. Never touch the delivery

Do not push, do not open a PR, do not merge a work package branch into master, and do
not run `tasks verify`. The work package's branches are the user's review surface for
the tasks that use Git; no-Git tasks are intentionally absent from them.

## 6. Report back

Tell the user:

- the work package, its branches, and how many of its tasks you worked
- per task: ref, title, what changed, whether its Git workflow was used, which
  branches it was merged into, and the checkpoint result
  (`unchanged` / `changed` + percentage), plus any scenario you wrote or
  extended and any before state you had to recapture with `--retro`
- anything you left unworked and why — a blocker, a conflict, a question
- any new tasks you filed along the way, including any filed with
  `--depends-on`
- whether anything was worked while blocked

Then point them at the work package's page, which shows each branch and what is on it:

```bash
tasks web
```

---

# Appendix: the `work-task` procedure

The steps above refer to this procedure by name. It is reproduced here in full
because this run has nothing installed beyond the `tasks` CLI and the harness
itself — treat every `$1` below as the task ref currently being worked, not the
work package ref from the top of this file.

$WORK_TASK_PROCEDURE
