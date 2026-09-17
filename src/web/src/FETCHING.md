# Fetching and pending UI

Use async `createMemo` reads and keep initial readiness under `Loading`.
After the first result, retain the previous content while the next request is
pending and bind `aria-busy` to `isPending(source)` inside that boundary.

Use `latest(query)` / `latest(selectedId)` for controls and selection markers
that should reflect the user's new intent immediately. Keep ordinary reads for
the rendered data and the fetching computation itself. `latest` is not needed
just to preserve stale content; `Loading` already does that.

```tsx
const listing = createMemo(() => api.listNotes({ q: query() }))

<Loading fallback={<PageSkeleton />}>
    <input value={latest(query)} onInput={e => setQuery(e.currentTarget.value)} />
    <section aria-busy={isPending(listing) ? "true" : "false"}>
        <For each={listing().notes}>{note => <p>{note.title}</p>}</For>
    </section>
</Loading>
```

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
