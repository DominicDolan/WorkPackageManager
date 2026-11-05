# Save performance review

The save workflow includes refreshing the UI after the write. Work done during
that refresh can delay the save indicator even when the database write itself
is quick.

## Changes

- Tool discovery used synchronous agent/version and GitHub authentication
  commands on every workspace refresh. It now runs asynchronously, shares
  concurrent requests, and caches the results for 60 seconds. Changing the
  configured agent starts a new probe immediately; check names and counts stay
  current. Missing executables report unavailable.
- Default branch discovery could call `gh repo view` repeatedly while building
  branch lists and work package details. It now prefers the configured base,
  then a valid local `origin/HEAD`. GitHub discovery and its fallback are cached
  for 60 seconds when no local default exists. Local `origin/HEAD` changes are
  read immediately. `git remote set-head origin -a` can update that local record
  after the remote's default branch changes.
- Notes listing read and parsed every Markdown file three times to assemble
  cards, folders, and tags. All three now share one read, with facets still
  drawn from the entire unfiltered collection.
- Live events now respect their storage channel. Notes updates refresh Notes
  without fetching task lists, branch histories, or tool metadata. Task updates
  refresh the task workspace. Transcripts observe both channels because their
  files live in Notes and their links refer to task records.

## Verification

`src/server/performance.test.ts` uses isolated temporary workspaces and slow fake
tools. It verifies concurrent probe sharing, server event-loop responsiveness,
cache expiry, config changes, missing executables, local default branch changes,
failed GitHub discovery, and filtered Notes results with unfiltered facets.

In one local run, eight concurrent tool requests shared three child processes.
The initial simulated probes took about 330 ms; a cached request took about
0.05 ms. Five Notes listings over 200 files took about 23 ms with the previous
three-read composition and 14 ms with the shared read. These are component
measurements using fixtures, not production save latency guarantees.

The browser reactivity fixture checks channel filtering and that refreshes retain
existing DOM nodes and unfinished editor drafts. Type checking and the production
build also pass. All 12 test files pass when run separately. Running them together
in one Bun process exposes shared cached-workspace configuration between the
existing test files, causing transcripts and visual-sync tests to use another
file's workspace.

## Further candidates

- Notes auto-commit still invokes Git synchronously before returning a save.
  Large notes repositories or slow Git hooks can delay the response and other
  requests. Moving it off the event loop needs a serialized commit queue so
  simultaneous saves cannot interfere with staging or Git's index lock.
- Branch detail assembly still launches several synchronous local Git commands
  per branch, and explicit mutation refreshes can overlap with live events.
  Large workspaces would benefit from asynchronous, shared reads keyed to Git
  refs, plus coordinated mutation/event refreshes.
- Repositories with neither a configured base nor local `origin/HEAD` still do
  a synchronous GitHub lookup on a cache miss. Making base resolution async
  throughout the CLI, branch operations, and detail builders would remove that
  remaining network wait from the server thread.

Reproduce actual slow saves with browser Network timing to distinguish the
mutation response from the subsequent refresh requests before choosing the next
change. The review did not measure a user's live workspace or modify its data.
