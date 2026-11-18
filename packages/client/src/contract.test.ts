/**
 * The client and the server's route table must describe the same API.
 *
 * Every client method is called with placeholder arguments against a fake
 * `fetch` that records the request; each request must match a declared route,
 * and every declared route must be reachable from some client method. Adding
 * a route without a client method (or the reverse) fails here, not in a UI.
 */
import { describe, expect, test } from "bun:test"
import { describeRoutes } from "@work-task-manager/server"
import { createClient } from "./client"

/** Routes a client deliberately reaches some other way. */
const NOT_CLIENT_METHODS = new Set([
    "GET /routes", // discovery, for tools rather than UIs
])

function pattern(path: string): RegExp {
    const body = path
        .split("/")
        .filter(Boolean)
        .map((part) =>
            part.startsWith(":")
                ? "[^/]+"
                : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        )
        .join("/")
    return new RegExp(`^/api${body ? `/${body}` : "/?"}$`)
}

const routes = describeRoutes().map((one) => ({
    ...one,
    regex: pattern(one.path),
}))

function routeFor(method: string, url: string) {
    const path = url.replace(/^https?:\/\/[^/]+/, "").replace(/\?.*$/, "")
    // Most specific first: literal segments beat params, as the router does.
    const matches = routes.filter(
        (one) => one.method === method && one.regex.test(path),
    )
    matches
        .sort((a, b) => b.path.split(":").length - a.path.split(":").length)
        .reverse()
    return matches[0]
}

async function recordedRequests() {
    const requests: { name: string; method: string; url: string }[] = []
    let current = ""
    const api = createClient({
        fetch: async (input, init) => {
            requests.push({
                name: current,
                method: init?.method ?? "GET",
                url: input,
            })
            return new Response("{}", {
                headers: { "content-type": "application/json" },
            })
        },
    })
    // EventSource is not a fetch; record it by hand.
    const originalEventSource = globalThis.EventSource
    globalThis.EventSource = class {
        constructor(url: string) {
            requests.push({ name: "subscribe", method: "GET", url })
        }
        addEventListener() {}
        close() {}
    } as never
    try {
        for (const [name, value] of Object.entries(api)) {
            if (typeof value !== "function") continue
            current = name
            const before = requests.length
            try {
                const result = (value as (...args: unknown[]) => unknown)(
                    "x",
                    "y",
                    "z",
                )
                if (typeof result === "string" && result.startsWith("/api")) {
                    requests.push({ name, method: "GET", url: result })
                } else if (typeof result === "function") {
                    ;(result as () => void)() // an unsubscribe
                } else await result
            } catch {
                // Placeholder arguments may not survive the response handling; the
                // request was still recorded, which is all this test needs. A
                // method that failed before sending (an upload wanting a file
                // list) gets one retry with an array.
                if (requests.length === before)
                    await Promise.resolve(
                        (value as (...args: unknown[]) => unknown)("x", []),
                    ).catch(() => {})
            }
            if (requests.length === before && name !== "subscribe")
                requests.push({ name, method: "NONE", url: "" })
        }
    } finally {
        globalThis.EventSource = originalEventSource
    }
    return requests
}

describe("client ↔ route table", async () => {
    const requests = await recordedRequests()

    test("every client method sends a request", () => {
        expect(
            requests
                .filter((one) => one.method === "NONE")
                .map((one) => one.name),
        ).toEqual([])
    })

    test("every client request matches a declared route", () => {
        const unrouted = requests
            .filter(
                (one) =>
                    one.method !== "NONE" && !routeFor(one.method, one.url),
            )
            .map((one) => `${one.name}: ${one.method} ${one.url}`)
        expect(unrouted).toEqual([])
    })

    test("every declared route has a client method", () => {
        const reached = new Set(
            requests
                .map((one) => routeFor(one.method, one.url))
                .filter(Boolean)
                .map((one) => `${one!.method} ${one!.path}`),
        )
        const missing = routes
            .map((one) => `${one.method} ${one.path}`)
            .filter((key) => !reached.has(key) && !NOT_CLIENT_METHODS.has(key))
        expect(missing).toEqual([])
    })
})
