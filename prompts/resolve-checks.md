Resolve the failed checks on delivery branch `$1`.

The check report and any extra instructions are included below. Treat that
report as the starting evidence, not as a substitute for inspecting the code.

Before editing:

1. Run `git status --short` and `git branch --show-current`.
2. Confirm the working tree is on `$1` and does not contain unrelated user
   changes. If it is on another branch and there are no uncommitted changes to `$1`. 
   Other than that, stop and tell the user; do not stash, reset, or discard their work.
3. Read the relevant code and reproduce each failed check from its reported
   working directory.

Then diagnose the root cause, make the smallest coherent fix, and rerun every
failed command. Also run any closely related validation needed to show the fix
did not create a regression. Do not change task statuses, create or open a pull
request, force-push, or hide failures by weakening checks.

If the cherry-pick check fails you can re-write history or drop commits as long as it 
doesn't change the resulting changes of the branch.

Finish with a concise report of the cause, files changed, commands run, and
whether every failed check now passes. If a failure cannot safely be resolved,
leave the repository recoverable and explain the blocker.
