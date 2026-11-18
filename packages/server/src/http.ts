/** Response helpers every route module shares. */

/** Throw from a handler to answer with a specific status and message. */
export class HttpError extends Error {
    constructor(
        readonly status: number,
        message: string,
    ) {
        super(message)
    }
}

export function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json; charset=utf-8" },
    })
}

/** 201 with a JSON body. */
export function created(body: unknown): Response {
    return json(body, 201)
}

export function fail(message: string, status = 400): Response {
    return json({ error: message }, status)
}

/** A file streamed off disk. */
export function file(path: string, cacheControl: string): Response {
    return new Response(Bun.file(path), {
        headers: { "cache-control": cacheControl },
    })
}

/**
 * Turn a thrown error into the response a client expects. Domain lookups
 * (`requireTask` and friends) throw "No … with ref" messages, which map to 404;
 * every other domain error is the caller's mistake, a 400.
 */
export function errorResponse(error: unknown): Response {
    if (error instanceof HttpError) return fail(error.message, error.status)
    const message = error instanceof Error ? error.message : String(error)
    const missing =
        /^No (task|investigation) with ref/.test(message) ||
        /^No work package with ref or name/.test(message) ||
        /^No agent run with id/.test(message) ||
        /^No (note|issue) at /.test(message)
    return fail(message, missing ? 404 : 400)
}
