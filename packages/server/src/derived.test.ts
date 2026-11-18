/**
 * Fields the server derives so a UI does not have to: when a task entered its
 * status, which blockers are unfinished, when a package was last worked on,
 * what to work next, and the order of a package's tabs. Driven through the HTTP
 * handler, so the route table is exercised too.
 */
import { afterAll, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const directory = mkdtempSync(join(tmpdir(), "derived-fields-"))
const git = (...args: string[]) =>
    Bun.spawnSync(["git", ...args], { cwd: directory }).exitCode
git("init", "-b", "main")
git(
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@example.invalid",
    "commit",
    "--allow-empty",
    "-m",
    "init",
)
mkdirSync(join(directory, ".tasks"))
writeFileSync(
    join(directory, ".tasks", "tasks.config.json"),
    JSON.stringify({ baseBranch: "main" }),
)
process.env.TASKS_DIR = join(directory, ".tasks")
process.env.TASKS_DB = join(directory, ".tasks", "tasks.db")

const { handleApiRequest, describeRoutes } = await import("./server")
afterAll(() => rmSync(directory, { recursive: true, force: true }))

async function call<T = Record<string, any>>(
    method: string,
    path: string,
    body?: unknown,
): Promise<T> {
    const response = await handleApiRequest(
        new Request(`http://local/api${path}`, {
            method,
            body: body === undefined ? undefined : JSON.stringify(body),
        }),
    )
    const payload = await response.json()
    if (!response.ok)
        throw new Error(
            `${method} ${path}: ${response.status} ${payload.error}`,
        )
    return payload as T
}

test("tasks carry statusSince and blockedBy; packages carry lastWorkedAt, nextTask and tabs", async () => {
    const { workPackage } = await call("POST", "/work-packages", {
        name: "Derived",
    })
    const first = (
        await call("POST", "/tasks", {
            title: "First",
            workPackageRef: workPackage.ref,
            useGitWorkflow: false,
        })
    ).task
    const second = (
        await call("POST", "/tasks", {
            title: "Second",
            workPackageRef: workPackage.ref,
            useGitWorkflow: false,
            dependsOn: [first.ref],
        })
    ).task

    expect(first.statusSince).toEqual({ verb: "Created", at: first.createdAt })
    expect(second.blockedBy).toEqual([first.ref])

    let detail = (await call("GET", `/work-packages/${workPackage.ref}`))
        .workPackage
    expect(detail.nextTask.ref).toBe(first.ref)
    expect(detail.tabs).toEqual([])
    expect(detail.lastWorkedAt).toBe(workPackage.createdAt)

    // Start the blocker: its statusSince moves, and the package was worked on.
    const started = (
        await call("POST", `/tasks/${first.ref}/status`, {
            status: "in_progress",
        })
    ).task
    expect(started.statusSince.verb).toBe("Started")
    expect(started.statusSince.at).toBe(started.startedAt)
    const summary = (await call("GET", "/work-packages")).workPackages.find(
        (one: { ref: string }) => one.ref === workPackage.ref,
    )
    expect(summary.lastWorkedAt).toBe(started.startedAt)

    // Finish it: the dependant is no longer blocked, and is next.
    await call("POST", `/tasks/${first.ref}/status`, { status: "dev_complete" })
    expect((await call("GET", `/tasks/${second.ref}`)).task.blockedBy).toEqual(
        [],
    )
    detail = (await call("GET", `/work-packages/${workPackage.ref}`))
        .workPackage
    expect(detail.nextTask.ref).toBe(second.ref)

    // An investigation shows up as a tab, keyed stably.
    const { investigation } = await call(
        "POST",
        `/work-packages/${workPackage.ref}/investigations`,
        { title: "Why" },
    )
    detail = (await call("GET", `/work-packages/${workPackage.ref}`))
        .workPackage
    expect(detail.tabs).toEqual([
        {
            key: `investigation:${investigation.ref}`,
            kind: "investigation",
            label: "Why",
            createdAt: investigation.createdAt,
        },
    ])
})

test("work package names with spaces resolve through an encoded path", async () => {
    await call("POST", "/work-packages", { name: "Search rework" })
    const { workPackage } = await call(
        "GET",
        `/work-packages/${encodeURIComponent("Search rework")}`,
    )
    expect(workPackage.name).toBe("Search rework")
})

test("routing answers 404 for unknown paths and 405 for known paths with the wrong method", async () => {
    const status = async (method: string, path: string) =>
        (
            await handleApiRequest(
                new Request(`http://local/api${path}`, { method }),
            )
        ).status
    expect(await status("GET", "/nope")).toBe(404)
    expect(await status("PUT", "/tasks")).toBe(405)
    // A literal segment is not read as a param: `reorder` is not a task ref.
    expect(await status("GET", "/tasks/reorder")).toBe(405)
    expect(
        describeRoutes().some((one) => one.path === "/tasks/:ref/status"),
    ).toBe(true)
})
