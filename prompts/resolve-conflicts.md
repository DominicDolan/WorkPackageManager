Bring branch `$1` up to date and resolve the conflicts that stopped it.

A conflict report is included below. It names the operation (`merge` or
`rebase`), the branch being updated, what it was being merged with or rebased
onto, the files Git reported as conflicted, and Git's own output. The attempt
that produced it was **aborted**, so the repository is back where it started:
you run the operation again yourself and resolve it this time. You are already
in the right repository — the report says whether it is the code repository or
the notes folder, which is a Git repository of its own.

Before starting:

1. Run `git status --short` and `git branch --show-current`.
2. Stop and tell the user if a merge or rebase is already in progress, or if
   there are uncommitted changes. Do not stash, reset, or discard their work.

Then run the operation from the report:

- **merge**: check out `$1` if it is not already, then
  `git merge --no-edit <onto>`.
- **rebase**: `git rebase <onto> $1`. Resolve each commit's conflicts as it
  stops, `git add` the files, and `git rebase --continue` until it finishes.

Resolve each conflict by understanding what both sides were trying to do, and
keep both intents wherever they are compatible. Do not just take "ours" or
"theirs" for a whole file unless one side clearly supersedes the other. When a
conflict is a genuine disagreement you cannot settle from the code, notes and
commit messages, stop and ask the user rather than guess.

After resolving, make sure no conflict markers remain (`git diff --check`, and
a search for `<<<<<<<`, `=======`, `>>>>>>>` in the files you touched). For a
code repository, run the checks relevant to the files that conflicted, such as
type-checking, tests or a build, and fix anything the resolution broke. For the
notes folder, check that each note you touched still has valid frontmatter.

Complete the merge commit or the rebase. Do not push, force-push, change task
statuses, or open a pull request. If you cannot finish safely, run
`git merge --abort` or `git rebase --abort` so the repository is left as you
found it, and explain the blocker.

Finish with a short report: which files conflicted, how you resolved each, what
you ran to check it, and the resulting commit.
