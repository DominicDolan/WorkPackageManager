import { currentRevisions, onChange } from "@work-task-manager/core/watch"

/** Heartbeat interval. Comfortably inside the server's idle timeout, so a quiet
 *  workspace does not have its stream reaped as dead. */
const SSE_HEARTBEAT_MS = 25_000

/**
 * `GET /api/events`: an SSE stream saying which store just changed.
 *
 * Deliberately carries no data beyond the channel and a revision number. The
 * client already knows how to load every view it can show; what it lacked was
 * any way to know it should. Sending the payload here would mean a second,
 * parallel definition of what each view needs, and one of the two would rot.
 */
export function eventStream(request: Request): Response {
    const encoder = new TextEncoder()
    let unsubscribe: (() => void) | undefined
    let heartbeat: ReturnType<typeof setInterval> | undefined

    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            const send = (text: string): void => {
                try {
                    controller.enqueue(encoder.encode(text))
                } catch {
                    // The client vanished between the event and this write; the abort
                    // handler below is what actually tears the stream down.
                }
            }

            // The opening frame carries where each channel stands, so a client that
            // reconnected after a dropped connection can see what it slept through.
            send(
                `event: hello\ndata: ${JSON.stringify({ revisions: currentRevisions() })}\n\n`,
            )
            unsubscribe = onChange((event) => {
                send(`event: change\ndata: ${JSON.stringify(event)}\n\n`)
            })
            heartbeat = setInterval(() => send(": ping\n\n"), SSE_HEARTBEAT_MS)

            request.signal.addEventListener("abort", () => {
                unsubscribe?.()
                if (heartbeat) clearInterval(heartbeat)
                try {
                    controller.close()
                } catch {
                    // Already closed by the runtime.
                }
            })
        },
        cancel() {
            unsubscribe?.()
            if (heartbeat) clearInterval(heartbeat)
        },
    })

    return new Response(stream, {
        headers: {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-store",
            connection: "keep-alive",
            // A stream that a proxy decides to buffer is a stream that never arrives.
            "x-accel-buffering": "no",
        },
    })
}
