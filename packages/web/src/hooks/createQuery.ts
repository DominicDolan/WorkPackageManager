import { createProjection, createStore, reconcile } from "solid-js"

/** Identity across fresh JSON responses, including nested heterogeneous lists. */
export function recordKey(item: Record<string, unknown>) {
    for (const field of ["ref", "id", "path", "branchName", "key"]) {
        if (item[field] != null) return `${field}:${item[field]}`
    }
}

/**
 * Reconcile server results at property level. The value slot lets null results
 * and navigation to a different entity replace identity; a projection's root
 * itself would keep the same identity even when its record key changes.
 * No committed seed: initial reads still suspend under Loading.
 */
export function createQuery<T>(fetcher: () => Promise<T>) {
    return createProjection<{ value: T }>(
        async () => ({ value: await fetcher() }),
        {},
        { key: recordKey },
    )
}

/**
 * A server record held locally, for data that arrives from mutations and polls
 * rather than a single fetcher. Each copy written is reconciled into the last
 * one the same way `createQuery` does, so a fresh JSON copy of the same record
 * keeps every unchanged row and notifies only the fields that changed. Writing
 * a different record (by `recordKey`), or undefined, replaces it outright.
 *
 * Never hold a server record in a plain signal: each response is a new object
 * graph, so every keyed `<For>` row and every `<Show keyed>` beneath it would
 * be rebuilt, losing text selection, focus, scroll and open `<details>`.
 */
export function createRecord<T extends object>() {
    const [state, setState] = createStore<{ value?: T }>({})
    const write = (next: T | undefined) =>
        setState((draft) => {
            const previous = draft.value as Record<string, unknown> | undefined
            if (
                next &&
                previous &&
                recordKey(previous) ===
                    recordKey(next as Record<string, unknown>)
            )
                reconcile(next, recordKey)(previous)
            else draft.value = next
        })
    return [() => state.value, write] as const
}
