import { createProjection } from "solid-js"

/** Identity across fresh JSON responses, including nested heterogeneous lists. */
function recordKey(item: Record<string, unknown>) {
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
