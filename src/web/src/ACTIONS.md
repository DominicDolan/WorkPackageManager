# Mutation workflows

UI operations that write data or start external work use `action` from
`solid-js`. Keep `api.ts` as the plain, typed HTTP transport: the action belongs
around the complete workflow, including reconciliation and success callbacks,
not around each individual request. Read memos and branch-progress polling stay
ordinary reads.

Use `useError` from `hooks/useError` for mutation errors that belong in an
inline notice. It is configured with a `banner` view, which exposes the inferred
`<Banner />` component alongside `handle`. The handler clears the prior error,
returns the request result on success, and records a readable message on failure.
Check the result before running success-only work:

```tsx
const { handle, hasError, Banner } = useError()
const save = action(async function* () {
    const result = await handle(() => api.save(input()))
    yield
    if (hasError()) return
    onSaved(result)
})

<Banner />
```

`defineErrorHandling` can take any number of presentation functions. Their
object keys determine the returned component names, with the first letter
capitalized (for example, `toast` creates `Toast`). Each view receives the
reactive message accessor.

Use `createOptimistic` for a temporary busy flag or action name. Set it inside
the action; Solid resets it when the transition settles, including on failure.
Guard duplicate calls and keep `disabled` and `aria-busy` bound to this value.
Do not manually reset it in `finally`.

```tsx
const [busy, setBusy] = createOptimistic(false)
const { capture, clear, Banner } = useError()

const save = action(function* () {
    if (busy()) return
    setBusy(true)
    clear()
    try {
        yield api.updateInvestigation(ref, { brief: brief() })
        yield refresh(detail)
    } catch (caught) {
        capture(caught)
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
        capture(caught)
    }
})

<Banner />
```

Use `yield refresh(source)` when reconciliation must finish before success.
Refresh callbacks should start reads synchronously in the caller's transition
(for multiple sources, return `Promise.all([refresh(a), refresh(b)])`). Avoid
plain async callbacks that call another refresh after an `await` without
restoring the transition.

Success-only UI changes belong inside the action's `try` block, after the
request and required refreshes. A caught failure must not close an editor or
erase its draft. The error hook stores messages in an ordinary signal so they
survive settlement.

Agent/check launch actions cover the launch request, not the lifetime of the
external process. Afterwards, server-reported run status drives loading state.
Branch checks optimistically mark the requested row before the response, then
follow `checksRunning.current`; other rows and previous output remain visible.

Browser regression fixtures: `/tests/actions.html` and `/tests/busy.html`.
Both use in-memory API requests and never mutate server data. See
`docs/solid-2.0/06-actions-optimistic.md` for the underlying Solid contracts.
