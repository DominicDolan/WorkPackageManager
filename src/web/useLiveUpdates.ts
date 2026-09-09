import { onMounted, onUnmounted, ref } from "vue"
import type { ChangeChannel, ChangeEvent } from "@shared/types"

/**
 * Keep the page in step with whatever else is writing to the workspace.
 *
 * The server streams "the tasks database moved" or "the notes folder moved"; the
 * handler passed in here decides what that means for what is on screen. No data
 * travels on the stream, so there is exactly one definition of how a view loads
 * — the one the view already had.
 *
 * `EventSource` reconnects by itself, which handles the ordinary case of the
 * server being restarted mid-session. What it cannot tell us is whether we
 * missed anything while it was away, so the stream opens with the current
 * revision of each channel and anything that has moved since the last one seen
 * is replayed to the handler as a change.
 */
export function useLiveUpdates(onChange: (channel: ChangeChannel) => void) {
  /** False while the stream is down — the UI says so rather than lying quietly. */
  const connected = ref(false)
  /** True once reconnecting has been given up on, e.g. an older server with no
   *  `/api/events`. Everything still works; it just will not update itself. */
  const unavailable = ref(false)

  let source: EventSource | null = null
  let failures = 0
  const seen: Partial<Record<ChangeChannel, number>> = {}

  /** A stream that fails this many times in a row is not coming back on its own. */
  const MAX_FAILURES = 6

  function handleRevisions(revisions: Record<string, number>): void {
    for (const [channel, revision] of Object.entries(revisions) as [
      ChangeChannel,
      number,
    ][]) {
      const previous = seen[channel]
      seen[channel] = revision
      // Undefined means this is the first connection of the session: the page
      // has just loaded its data, so there is nothing to catch up on.
      if (previous !== undefined && revision !== previous) onChange(channel)
    }
  }

  function connect(): void {
    source = new EventSource("/api/events")

    source.addEventListener("hello", (event) => {
      failures = 0
      connected.value = true
      const payload = JSON.parse((event as MessageEvent<string>).data) as {
        revisions: Record<string, number>
      }
      handleRevisions(payload.revisions)
    })

    source.addEventListener("change", (event) => {
      const change = JSON.parse(
        (event as MessageEvent<string>).data,
      ) as ChangeEvent
      seen[change.channel] = change.revision
      onChange(change.channel)
    })

    source.addEventListener("error", () => {
      connected.value = false
      // EventSource retries on its own, so this only has to notice when retrying
      // is pointless — a server too old to have the endpoint would otherwise
      // reconnect every few seconds for as long as the tab is open.
      if (++failures < MAX_FAILURES) return
      unavailable.value = true
      source?.close()
      source = null
    })
  }

  onMounted(connect)
  onUnmounted(() => {
    source?.close()
    source = null
  })

  return { connected, unavailable }
}
