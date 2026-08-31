Work a development task through to **Dev Complete**, with visual before/after
evidence attached to it.

Task ref (may be empty): `$1`

## 0. Refuse to start a second task

Before anything else:

```bash
tasks list --status in_progress --json
```

If that returns **any** task, work stops here — with one exception.

- **The exception:** a ref was given above and it names one of those
  in-progress tasks. That is resuming, not starting. Carry on, and skip
  `tasks start` in step 3.
- **Otherwise** — no ref given, or a ref naming a different task — **stop and
  warn.** Do not branch, do not capture, do not edit anything. Say which task is
  already in progress (ref and title), and give the user their options:
  - resume it: a `work-task` run targeting that ref
  - park it: `tasks edit <that-ref> --status backlog`
  - finish it: `tasks done <that-ref>`

  Then stop and wait. Only work a different task if the user, having been told,
  says to anyway.

One in-progress task at a time is the whole point: each task owns a branch and a
visual checkpoint, and two of them in flight means the "before" evidence of one
has the other's half-finished changes baked into it.

## 1. Pick the task

If a ref was given above, use it: `tasks show $1 --json`.

If it is empty, run `tasks list --json` and take the **first task in the list**.
That list is a manually ordered queue — the user arranges it, by dragging in
`tasks web` or with `tasks move` — so the top of it is the answer, whatever its
status or priority. Do not re-rank it, and do not skip past the top task because
something further down looks more appealing.

The only rows to skip are ones already finished: if the top task is
`dev_complete` or `verified`, walk down until you reach one that is not. (You
cannot meet an `in_progress` task here — step 0 already dealt with that — and
`closed` tasks are not in the list at all.)

If nothing is left, say so and stop. Do not invent a task.

State which task you selected and why before doing anything else. If it carries
a `recommendedTier` from `tasks show <ref> --json`, that was one investigating
agent's judgement of how much capability this task needs — worth a glance if the
model you are running as is a noticeably different tier, but not a reason to
stop.

## 1a. Check what the task is waiting for

Tasks can depend on other tasks: "T-4 cannot be done until T-2 is". The
dependencies are on the task itself — `dependsOn` in `tasks show <ref> --json` —
and the graph is readable directly:

```bash
tasks dep <ref>
```

A blocker counts as **met** once it reaches `dev_complete`, `verified` or
`closed`: by then its work exists on its branch, which is what this task needs.
Anything still `backlog` or `in_progress` is **unmet**.

**If any dependency is unmet, stop here.** Do not branch, do not capture, do not
edit anything. Tell the user:

- which task you were about to work, and which dependency is holding it up —
  ref, title and current status
- their options:
  - work the blocker first: a `work-task` run targeting the blocker
  - drop the dependency if it is wrong: `tasks dep rm <ref> <blocker-ref>`
  - work this task anyway, knowing the blocker's code will not be present

Then wait. Only carry on with a blocked task if the user, having been told,
says to — and if they do, say plainly in your final report that it was worked
while blocked.

Being blocked is a fact about the work, not a lock: the CLI will let you
proceed. The judgement is the user's, so it has to be theirs to make.

> `tasks` should be on PATH — it is the globally installed `work-task-manager`
> CLI. If it is not, say so and stop; there is no in-repo copy to fall back to.
> A repository with no `.tasks/` workspace needs `tasks init` first.

## 2. Check the preconditions

Capturing checkpoints drives a real browser against the running frontend:

```bash
curl -sk -o /dev/null -w '%{http_code}' https://localhost:5175/login
```

If that is not `200`, **stop and tell the user** the frontend is not running and
that they can start it with:

```bash
docker compose -f Infrastructure/Local/docker/docker-compose.fullstack.yml --profile modular up -d
```

Do not silently skip the checkpoint steps — the visual evidence is the point of
this workflow.

Also check the working tree is clean (`git status --short`). If it is dirty, ask
the user what to do rather than sweeping their changes onto a new branch.

## 3. Branch — from the group, from master, or from the dependency

```bash
git fetch origin
tasks branch <ref>
```

The task already owns a branch name — `tasks show <ref> --json` reports it as
`branchName`, and every other `tasks` command refuses to run from anywhere else.
`tasks branch` creates it and switches to it. Do not invent your own name; you
will only have to delete it and re-branch.

**It also chooses the start point, and it is not always master.** `tasks branch`
reports which start point it used; **read that line and repeat it in your final
report.**

- **the task is in a group** → the **group's branch**. A group owns a branch, and
  everything its finished tasks have delivered has been merged there — so it is
  the only start point that has all of it. The branch is created from the base
  the first time a task in the group needs it.
- no group, no finished dependencies → the base branch
- no group, one finished dependency → that task's branch. A finished
  dependency's work is on *its* branch and has not been merged anywhere yet, so
  a task that depends on it is cut from that branch — otherwise you would be
  writing against code that is not there.
- no group, several finished dependencies → `tasks branch` refuses, because one
  branch cannot be cut from two. Stop and ask the user: the usual answer is to
  combine those tasks into one delivery branch in `tasks web` and then
  `tasks branch <ref> --from <that-branch>`. Do not pick one yourself.
- a group whose branch is missing a finished dependency's work → `tasks branch`
  refuses and names it. Merge it first (`tasks merge <blocker-ref>`) or pass
  `--from`. Ask rather than choosing.

When you are branching off a group branch or a dependency, the baseline you
capture in step 5 includes that other work's changes. That is correct — the diff
you are about to produce should show *your* change and not the one you built on
top of.

Never work directly on `master`, and never force-push or merge.

### Keep the branch a straight line

A branch is not finished when it merges cleanly — it has to *replay* cleanly.
Downstream tooling copies a branch by cherry-picking its commits onto another
repository's base one at a time, and that is a weaker operation than the merge
you would do here. Two things break it:

- **A merge commit.** `git cherry-pick` refuses one outright. It does not matter
  that the merge was trivial, or that it resolved nothing.
- **A resolution that exists only inside a merge commit.** Replaying the
  *pre-merge* commits against a base that has moved reintroduces whatever the
  merge settled — a commit that edits a file the base has since deleted
  conflicts, even though merging the same branch is clean.

So: **never create a merge commit on a task or group branch.** When you need
work from somewhere else, replay onto it instead —

```bash
git rebase <that-branch> <your-branch>
```

`tasks done` already does exactly this for the task → group step (it rebases,
then fast-forwards). The gap is everything it does not do for you, and the one
that comes up is a task whose *job* is to bring the base branch in. Rebase there
too; do not `git merge master`, however natural it looks. If the branch has
already been pushed, rebasing needs a force-push — **stop and ask the user**
rather than deciding that yourself, because other branches may be cut from it.

## 4. Mark the task in progress

```bash
tasks start <ref>
```

Skip this if it is already `in_progress` — which, per step 0, means you are
resuming the task the user named.

## 5. Capture the "before" checkpoint

**This must happen before you edit anything.** `after` diffs against this fixed
reference; without it there is nothing to compare.

```bash
tasks checkpoint before <ref>
```

Scope it when the task only touches part of the UI — it is much faster:

```bash
tasks checkpoint before <ref> --scenario login.page
```

The filter is remembered, so `after` reuses it automatically. Report which
scenarios were captured.

## 6. Make the change

Do the actual work described by the task. Read `tasks show <ref> --json` for the
description and any notes.

Keep the change scoped to what the task asks for. If you discover something else
that needs doing, record it instead of widening this task:

```bash
tasks new "<the thing you found>" --priority medium
```

New tasks are appended to the bottom of the list, so filing one will not jump
the queue ahead of work the user has already ordered.

If what you found can only be done **after** this task — it builds on the change
you are making — record that, so whoever picks it up branches from your work
rather than from master:

```bash
tasks new "<the thing you found>" --priority medium --depends-on <ref>
```

Only when it genuinely has to wait. A dependency on everything in sight makes
the queue unworkable, and two tasks that merely touch the same file are not
dependent.

Add notes to the task as you go when something is worth remembering:

```bash
tasks note <ref> "<what you learned>"
```

## 7. Capture "after" and check your work

```bash
tasks checkpoint after <ref>
```

This is idempotent — it always compares against the same reference — so loop
`edit → after → edit → after` as often as you need.

Read the result. For each scenario it reports `unchanged`, `changed` or
`failed`:

- **`failed`** — the scenario errored. Fix that before continuing.
- **`changed`** — expected when the task is a visual change. Confirm the diff is
  what the task asked for and nothing else moved.
- **`unchanged`** on a task that was supposed to change something visually means
  your change did not take effect. Investigate rather than declaring success —
  a common cause is the frontend container serving a stale build.

## 8. Commit on the branch

```bash
git add -A
git commit -m "<message>"
```

Commit to the task branch only. **Do not push, merge, or touch master** — the
user reviews the screenshots first.

Before moving on, confirm the branch is still a straight line:

```bash
git rev-list --merges $(git merge-base master HEAD)..HEAD
```

Anything printed is a merge commit that will block the downstream copy. Go back
and read "Keep the branch a straight line" in step 3.

## 9. Mark it dev complete

```bash
tasks done <ref>
```

This captures a final `after` checkpoint, moves the task to `dev_complete`, and —
**if the task is in a group** — merges its branch into the group's branch and
registers it there, returning you to the task's branch. All in one step. If you
just ran step 7 and do not want to re-drive the browser, use
`tasks done <ref> --no-checkpoint`.

Read the output. Two things can go wrong independently of the status change,
which happens either way:

- **the capture failed** — reported as `captureError` with `--json`. Say so.
- **the task's commits do not replay onto the group branch** — reported as
  `mergeError`. Its commits are rebased onto the group branch and fast-forwarded
  in, so the group branch stays a straight list rather than a chain of merges,
  and a collision with work already there stops that. **Nothing is left
  half-done**: the rebase is aborted, both branches are as they were, and you are
  back on the branch you started on. **Stop and hand it back.** Do not resolve a
  collision between two of the user's tasks yourself. Say which two pieces of
  work conflicted; once they have rebased and resolved it, `tasks merge <ref>`
  registers the task.

  A branch that has already been pushed is refused outright, because replaying it
  would need a force-push afterwards. Report that and stop.

`tasks done <ref> --no-merge` skips the merge if the user has asked you to leave
the group branch alone.

Leave the task at `dev_complete`. **Do not run `tasks verify`** — that is the
user signing off after looking at the before/after themselves.

Getting the task out of `in_progress` is also what unblocks the next task, so do
not leave it hanging there.

## 10. Report back

Tell the user:

- which task you worked and what you changed
- the branch name, **and what it was cut from** — say so explicitly when it was
  a group branch or a dependency's branch rather than the base, because that
  branch cannot be merged before the one it sits on
- whether it was merged into a group branch, and which one
- the per-scenario checkpoint result (`unchanged` / `changed` + percentage)
- anything you deliberately left out, and any new tasks you filed — including
  any you filed with `--depends-on`
- whether the task was blocked and worked anyway, if that is what happened

Then point them at the review UI:

```bash
tasks web
```
