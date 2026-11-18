import type { ChangeChannel, ChangeEvent } from "@work-task-manager/shared"

/**
 * `GET /api/events` as a callback. The stream says only which store changed
 * (`tasks` or `notes`) and its new revision; the payload stays behind the
 * ordinary endpoints so there is one definition of what each view loads.
 *
 * `EventSource` reconnects by itself. Each (re)connection opens with a `hello`
 * frame of the current revisions, passed to `onOpen`, so a client that slept
 * through changes can tell and reload.
 */
export function subscribeToChanges(
    baseUrl: string,
    onChange: (event: ChangeEvent) => void,
    onOpen?: (revisions: Record<ChangeChannel, number>) => void,
): () => void {
    const source = new EventSource(`${baseUrl}/api/events`)

    const changed = (message: MessageEvent) => {
        let event: ChangeEvent
        try {
            event = JSON.parse(message.data) as ChangeEvent
        } catch {
            return
        }
        onChange(event)
    }
    const hello = (message: MessageEvent) => {
        if (!onOpen) return
        try {
            onOpen(JSON.parse(message.data).revisions)
        } catch {
            // A malformed hello carries nothing worth acting on.
        }
    }

    source.addEventListener("change", changed)
    source.addEventListener("hello", hello)
    return () => source.close()
}
