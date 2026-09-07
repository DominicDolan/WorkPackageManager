Work every unfinished task in one **group**, in an order that respects their
dependencies, leaving each one Dev Complete and merged into the group's branch.

Group (may be empty): `$1`

This command is a loop around the `work-task` procedure, appended in full below
this file. It does not replace it: each task is worked by the same steps, with
the same checkpoint discipline. What this adds is the order, the group branch,
and knowing when to stop.

## 0. Resolve the group

```bash
tasks group queue $1 --json
```

If `$1` is empty, **stop and ask** which group. Do not pick one — a group is a
commitment to a branch, and guessing which one is not recoverable by the user
noticing later.

That command returns the group (including its `branchName`) and `queue`: the
unfinished tasks already sorted so nothing comes before what it depends on.
**That order is the answer.** Do not re-derive it, and do not reorder it because
something looks easier.

If the queue is empty, say so and stop — everything in the group is already Dev
Complete or beyond.

## 1. Check what the group cannot clear itself

Each queue entry carries `blockedBy` and `blockedByOutside`.

- `blockedByOutside` is non-empty → that task waits on work **outside this
  group**, which this run will never do. **Stop before starting** and tell the
  user which tasks and which blockers, and offer their options: work the blocker
  first (a `work-task` run targeting it), drop the dependency
  (`tasks dep rm <ref> <blocker-ref>`), or say to proceed anyway and have those
  tasks worked while blocked.
- `blockedBy` containing only refs from inside the group is **fine** — the queue
  order clears them as it goes.

## 2. Check the preconditions once

Do this once for the whole run, not per task:

- The working tree is clean (`git status --short`). If it is dirty, ask rather
  than sweeping the user's changes onto a branch.
- `git fetch origin`.
- Whatever the `work-task` procedure's step 2 requires of this repository — the
  frontend being up for checkpoint capture, and anything else it names. If that
  is not satisfied, stop and say so. Do not silently skip checkpoints for a
  whole group; that is a lot of evidence to quietly not collect.

Also confirm nothing else is mid-flight:

```bash
tasks list --status in_progress --json
```

If a task is already in progress and it is **not** the first entry in this
group's queue, stop and warn — same rule as the `work-task` procedure's step 0,
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
quietly dropped, and a group delivered with no evidence for half its tasks is
the thing this workflow exists to prevent.

Three things are specific to working inside a group:

**The branch comes from the group, not from master.** `tasks branch <ref>` picks
the start point itself and will choose the group's branch, so still just run:

```bash
tasks branch <ref>
```

It prints what it branched from. Read that line. If it says anything other than
the group's branch, **stop and report it** rather than carrying on — it means
the group's branch is not where you think it is.

**`tasks done` merges the task back into the group branch** and registers it
there, then returns you to the task's branch. Read its output:

- `merged into <group branch>` — good, carry on to the next task.
- A conflict — the task's commits do not replay onto the group branch. It aborts
  and changes nothing, leaving both branches as they were. **Stop the whole
  run.** Do not resolve a collision between two of the user's tasks on your own
  judgement. Report which two pieces of work collided and leave it for them.

It rebases before it fast-forwards, which is what keeps the group branch a
straight run of commits rather than a chain of merges. **Do not undo that with a
merge of your own.** A merge commit anywhere on the group branch cannot be
cherry-picked, and downstream copies of the branch are cherry-picks — so one
`git merge` here breaks the copy of every task on the branch, not just yours.
That includes bringing the base branch in: if the group branch needs `master`,
that is `git rebase origin/master <group branch>`, it needs a force-push if the
branch is pushed, and it is the user's call. Stop and ask.

**Re-read the queue between tasks.** Working a task changes what is unblocked,
and the user may have edited the group meanwhile:

```bash
tasks group queue <group-ref> --json
```

Take the first entry that is not yet `dev_complete`. This is also how you notice
a task that was added to the group while you were working.

## 4. Stop early rather than pushing through

Stop the run and report where you got to if any of these happen. None of them
are yours to decide:

- a collision on `tasks done`, or a task branch it refuses to replay
- a checkpoint scenario that reports `failed`
- a task whose description turns out to need a decision the user has not made
- `tasks branch` starting from somewhere unexpected
- anything that would need a force-push, a rebase, or a change to master

Tasks already finished stay finished — a stopped run leaves the group partly
delivered, which is the normal and recoverable state, not a mess to tidy up.

## 5. Never touch the delivery

Do not push, do not open a PR, do not merge the group branch into master, and do
not run `tasks verify`. The group branch is the user's to review — the whole
point of the merges is that there is one branch for them to look at.

## 6. Report back

Tell the user:

- the group, its branch, and how many of its tasks you worked
- per task: ref, title, what changed, and the checkpoint result
  (`unchanged` / `changed` + percentage), plus any scenario you wrote or
  extended and any before state you had to recapture with `--retro`
- anything you left unworked and why — a blocker, a conflict, a question
- any new tasks you filed along the way, including any filed with
  `--depends-on`
- whether anything was worked while blocked

Then point them at the group's page, which shows the branch and what is on it:

```bash
tasks web
```

---

# Appendix: the `work-task` procedure

The steps above refer to this procedure by name. It is reproduced here in full
because this run has nothing installed beyond the `tasks` CLI and the harness
itself — treat every `$1` below as the task ref currently being worked, not the
group ref from the top of this file.

$WORK_TASK_PROCEDURE
