# Mutation workflows

UI operations that write data or start external work use `action` from
`solid-js`. Keep `api.ts` as the plain, typed HTTP transport: the action belongs
around the complete workflow, including reconciliation and success callbacks,
not around each individual request. Read memos and branch-progress polling stay
ordinary reads.

Use `createOptimistic` for a temporary busy flag or action name. Set it inside
the action; Solid resets it when the transition settles, including on failure.
Guard duplicate calls and keep `disabled` and `aria-busy` bound to this value.
Do not manually reset it in `finally`.

```tsx
const [busy, setBusy] = createOptimistic(false)
const [error, setError] = createSignal("")

const save = action(function* () {
    if (busy()) return
    setBusy(true)
    setError("")
    try {
        yield api.updateInvestigation(ref, { brief: brief() })
        yield refresh(detail)
    } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught))
    }
})
```

For typed response values, use the documented async-generator form:

```tsx
const create = action(async function* () {
    if (busy()) return
    setBusy(true)
    try {
        const result = await api.createTask(input())
        yield // Restore the action's transition before reactive writes/callbacks.
        created(result.ref)
    } catch (caught) {
        yield // An await rejection also leaves the transition context.
        setError(caught instanceof Error ? caught.message : String(caught))
    }
})
```

Use `yield refresh(source)` when reconciliation must finish before success.
Refresh callbacks should start reads synchronously in the caller's transition
(for multiple sources, return `Promise.all([refresh(a), refresh(b)])`). Avoid
plain async callbacks that call another refresh after an `await` without
restoring the transition.

Success-only UI changes belong inside the action's `try` block, after the
request and required refreshes. A caught failure must not close an editor or
erase its draft. Error messages use ordinary signals so they survive settlement.

Agent/check launch actions cover the launch request, not the lifetime of the
external process. Afterwards, server-reported run status drives loading state.
Branch checks optimistically mark the requested row before the response, then
follow `checksRunning.current`; other rows and previous output remain visible.

Browser regression fixtures: `/tests/actions.html` and `/tests/busy.html`.
Both use in-memory API requests and never mutate server data. See
`docs/solid-2.0/06-actions-optimistic.md` for the underlying Solid contracts.
