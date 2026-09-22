# Fetching and pending UI

Use `createQuery` for server records and lists that refresh. It wraps an async
`createProjection` and reconciles JSON by record identity (`ref`, `id`, `path`,
`branchName`, or `key`), preserving rows and notifying only changed properties.
Read `query.value`, refresh with `refresh(query)`, and probe pending state with
`isPending(() => query.value)`. The value slot also preserves null results and
replaces identity on navigation to a different record. Keep initial readiness
under `Loading`.
After the first result, retain the previous content while the next request is
pending and bind `aria-busy` to `isPending(source)` inside that boundary.

Use `latest(query)` / `latest(selectedId)` for controls and selection markers
that should reflect the user's new intent immediately. Keep ordinary reads for
the rendered data and the fetching computation itself. `latest` is not needed
just to preserve stale content; `Loading` already does that.

```tsx
const listing = createQuery(() => api.listNotes({ q: query() }))

<Loading fallback={<PageSkeleton />}>
    <input value={latest(query)} onInput={e => setQuery(e.currentTarget.value)} />
    <section aria-busy={isPending(() => listing.value) ? "true" : "false"}>
        <For each={listing.value.notes}>{note => <p>{note.title}</p>}</For>
    </section>
</Loading>
```

Keep `createMemo` for scalar/computed values, and async sources such as model
catalogues whose whole value should change together. Use keyed projections for
derived lists that manufacture row objects (for example, workspace tabs).
Do not copy store fields into nonreactive locals. Effects must read the fields
they observe in their compute function; watching only a record's identity no
longer observes its edits. Use `deep(record)` when an effect needs a full plain
snapshot, such as synchronizing an editable draft with server changes.

When switching records, keep old details visible but `inert` until the requested
record settles. Put the pending indicator on the requested navigation row too.
Do not let stale editable content act as though it belongs to the new record.

Model catalogues are async memos keyed by harness. The picker is disabled and
its old options hidden during a switch; Solid handles superseded requests.
Launch controls observe `isPending(harness)` to prevent launching while that
specific selection is held in a transition. This observes the held selection,
not arbitrary downstream fetching. Catalogue failures retain the existing
harness-default fallback.

A bare `refresh()` (including background event refreshes) stays quiet.
Mutation progress continues to use optimistic flags as described in
[ACTIONS.md](./ACTIONS.md). Do not treat `isPending` as a generic network flag.

`/tests/fetching.html` exercises initial loading, rapid search and navigation,
stale-edit protection, quiet refreshes, and out-of-order model responses using
in-memory API requests. Run it through the development web server.

`/tests/reactivity.html` checks fresh-JSON reconciliation, field-level computation
counts, row moves/removal, editor drafts and record navigation, and real App
event refreshes preserving work package cards, tabs, and investigation panels.
