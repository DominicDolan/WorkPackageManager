/**
 * `@work-task-manager/client` — everything a UI needs to drive the API.
 *
 * ```ts
 * import { createClient } from "@work-task-manager/client"
 *
 * const api = createClient() // same origin as the page
 * const packages = await api.listWorkPackages()
 * const stop = api.subscribe(({ channel }) => {
 *     if (channel === "tasks") refresh()
 * })
 * ```
 *
 * Every type the API returns is re-exported here, so a UI needs no second
 * dependency to name them.
 */
export * from "./client"
export { subscribeToChanges } from "./events"
export * from "@work-task-manager/shared"
