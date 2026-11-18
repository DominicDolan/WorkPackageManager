/**
 * The API as a table of routes.
 *
 * Each route is a method, a path pattern (`/tasks/:ref/status`), a one-line
 * summary and a handler. The table is the single description of what the API
 * serves: the router matches against it, `GET /api/routes` publishes it, and
 * the client's contract test checks every client method against it.
 *
 * Matching is by segment. A literal segment beats a `:param` in the same
 * position, so `/tasks/reorder` is never read as the task `reorder`. The most
 * specific matching pattern decides the answer: if it has no handler for the
 * method, the reply is 405, even when a less specific pattern would have
 * accepted it. Params arrive percent-decoded, which is how branch names and
 * note paths (both containing slashes) travel as one segment.
 */
import { HttpError, json } from "./http"

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE"

export interface Context {
    request: Request
    url: URL
    params: Record<string, string>
    query: URLSearchParams
    /** The JSON body. A missing or malformed one is a 400. */
    body<T>(): Promise<T>
    /** The JSON body, or `fallback` when there is none or it does not parse. */
    bodyOr<T>(fallback: T): Promise<T>
}

/** A handler returns a `Response`, or any value to send as 200 JSON. */
export type Handler = (context: Context) => unknown

export interface Route {
    method: Method
    path: string
    summary: string
    handler: Handler
}

export interface RouteDescription {
    method: Method
    path: string
    summary: string
}

export function route(
    method: Method,
    path: string,
    summary: string,
    handler: Handler,
): Route {
    return { method, path, summary, handler }
}

interface Compiled extends Route {
    segments: string[]
}

function split(path: string): string[] {
    return path.split("/").filter(Boolean)
}

function decode(segment: string): string {
    try {
        return decodeURIComponent(segment)
    } catch {
        throw new HttpError(400, "Malformed percent-encoding in the path.")
    }
}

function match(
    pattern: string[],
    segments: string[],
): Record<string, string> | null {
    if (pattern.length !== segments.length) return null
    const params: Record<string, string> = {}
    for (let index = 0; index < pattern.length; index++) {
        const expected = pattern[index]!
        const actual = segments[index]!
        if (expected.startsWith(":")) params[expected.slice(1)] = decode(actual)
        else if (expected !== actual) return null
    }
    return params
}

/** Literal segments outrank params, position by position from the left. */
function specificity(pattern: string[]): string {
    return pattern.map((part) => (part.startsWith(":") ? "0" : "1")).join("")
}

export interface Router {
    handle(request: Request, url: URL, prefix: string): Promise<Response>
    describe(): RouteDescription[]
}

export function createRouter(routes: Route[]): Router {
    const compiled: Compiled[] = routes.map((one) => ({
        ...one,
        segments: split(one.path),
    }))
    const seen = new Set<string>()
    for (const one of compiled) {
        const key = `${one.method} ${one.segments.map((s) => (s.startsWith(":") ? ":" : s)).join("/")}`
        if (seen.has(key)) throw new Error(`Duplicate route: ${key}`)
        seen.add(key)
    }

    return {
        describe: () =>
            routes.map(({ method, path, summary }) => ({
                method,
                path,
                summary,
            })),

        async handle(request, url, prefix) {
            const segments = split(url.pathname.slice(prefix.length))
            let best: { rank: string; pattern: string } | null = null
            const candidates: {
                route: Compiled
                params: Record<string, string>
            }[] = []
            for (const one of compiled) {
                const params = match(one.segments, segments)
                if (!params) continue
                const rank = specificity(one.segments)
                const pattern = one.segments.join("/")
                if (!best || rank > best.rank) best = { rank, pattern }
                candidates.push({ route: one, params })
            }
            if (!best) return json({ error: "Unknown endpoint." }, 404)

            const chosen = candidates.find(
                (one) =>
                    one.route.segments.join("/") === best!.pattern &&
                    one.route.method === request.method,
            )
            if (!chosen) return json({ error: "Method not allowed." }, 405)

            const context: Context = {
                request,
                url,
                params: chosen.params,
                query: url.searchParams,
                body: async <T>() => {
                    try {
                        return (await request.json()) as T
                    } catch {
                        throw new Error("Request body must be valid JSON.")
                    }
                },
                bodyOr: async <T>(fallback: T) => {
                    try {
                        return (await request.json()) as T
                    } catch {
                        return fallback
                    }
                },
            }
            const result = await chosen.route.handler(context)
            return result instanceof Response ? result : json(result)
        },
    }
}
