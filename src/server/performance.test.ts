import { afterAll, expect, test } from "bun:test"
import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const directory = mkdtempSync(join(tmpdir(), "save-performance-"))
const tasksDir = join(directory, ".tasks")
const notesDir = join(directory, "notes")
const binDir = join(directory, "bin")
for (const path of [tasksDir, notesDir, binDir]) mkdirSync(path)
const log = join(directory, "probes.log")
writeFileSync(log, "")
// Slow external tools make duplicate probes and event-loop blocking observable.
for (const name of ["gh", "test-agent"])
    writeFileSync(
        join(binDir, name),
        `#!/bin/sh
echo "$0 $*" >> "$PERFORMANCE_PROBE_LOG"
sleep 0.15
if [ "$1" = repo ]; then
    [ "$PERFORMANCE_GH_FAIL" = 1 ] && exit 1
    echo main
fi
exit 0
`,
        { mode: 0o755 },
    )

afterAll(() => rmSync(directory, { recursive: true, force: true }))

test("discovery shares slow probes, stays responsive, expires, and honors config changes", async () => {
    // A separate process isolates workspace configuration and PATH from other tests.
    const child = Bun.spawn(
        [
            process.execPath,
            "-e",
            `
import { expect } from "bun:test"
import { readFileSync } from "node:fs"
const git = (...args) => {
    const result = Bun.spawnSync(["git", ...args], { cwd: process.env.PERFORMANCE_REPO })
    expect(result.exitCode).toBe(0)
}
git("init", "-b", "main")
git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "Initial")
git("update-ref", "refs/remotes/origin/main", "HEAD")
git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main")
const { defaultBaseBranch, toolAvailability } = await import(${JSON.stringify(join(import.meta.dir, "branches.ts"))})
const { workspace } = await import(${JSON.stringify(join(import.meta.dir, "../config/paths.ts"))})
const ws = workspace()
const probes = () => readFileSync(process.env.PERFORMANCE_PROBE_LOG, "utf8").trim().split("\\n").filter(Boolean)
expect(defaultBaseBranch()).toBe("main")
expect(defaultBaseBranch()).toBe("main")
expect(probes()).toHaveLength(0)
// Local remote HEAD changes are observed immediately.
git("update-ref", "refs/remotes/origin/trunk", "HEAD")
git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk")
expect(defaultBaseBranch()).toBe("trunk")
git("symbolic-ref", "--delete", "refs/remotes/origin/HEAD")
expect(defaultBaseBranch()).toBe("main")
expect(defaultBaseBranch()).toBe("main")
expect(probes()).toHaveLength(1)
const realNow = Date.now
let offset = 0
Date.now = () => realNow() + offset
offset += 61_000
process.env.PERFORMANCE_GH_FAIL = "1"
expect(defaultBaseBranch()).toBe("main")
expect(defaultBaseBranch()).toBe("main")
expect(probes()).toHaveLength(2)
ws.config.baseBranch = "configured"
expect(defaultBaseBranch()).toBe("configured")
expect(probes()).toHaveLength(2)

ws.config.prAgent = ["test-agent"]
let settled = false
const started = performance.now()
const requests = Promise.all(Array.from({ length: 8 }, () => toolAvailability()))
requests.then(() => settled = true)
await new Promise(resolve => setTimeout(resolve, 30))
expect(settled).toBe(false)
const results = await requests
for (const result of results) {
    expect(result.prAgentAvailable).toBe(true)
    expect(result.gh).toBe(true)
    expect(result.ghAuthed).toBe(true)
}
expect(probes()).toHaveLength(5)
const cold = performance.now() - started
const warmStart = performance.now()
await toolAvailability()
expect(probes()).toHaveLength(5)
console.log(JSON.stringify({ coldToolProbeMs: cold, cachedToolProbeMs: performance.now() - warmStart, concurrentRequests: 8, toolProcesses: 3 }))
offset += 61_000
await toolAvailability()
expect(probes()).toHaveLength(8)
ws.config.prAgent = ["nonexistent-performance-test-agent"]
ws.config.checks = [{ name: "new check", command: ["true"], cwd: "." }]
const changed = await toolAvailability()
expect(changed.prAgentAvailable).toBe(false)
expect(changed.checkNames).toEqual(["new check"])
expect(changed.checkCount).toBe(1)
Date.now = realNow
`,
        ],
        {
            env: {
                ...process.env,
                TASKS_DIR: tasksDir,
                TASKS_NOTES_DIR: notesDir,
                PATH: `${binDir}:${process.env.PATH}`,
                PERFORMANCE_PROBE_LOG: log,
                PERFORMANCE_REPO: directory,
            },
            stdout: "pipe",
            stderr: "pipe",
        },
    )
    const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
    ])
    expect(stderr + stdout).not.toContain("error:")
    expect(exitCode).toBe(0)
    console.log(stdout.trim())
    expect(readFileSync(log, "utf8")).toContain("auth status")
})

test("one-pass notes listing preserves filtered results and unfiltered facets", async () => {
    mkdirSync(join(notesDir, "plans"), { recursive: true })
    for (let i = 0; i < 200; i++)
        writeFileSync(
            join(notesDir, i % 2 ? `plans/note-${i}.md` : `note-${i}.md`),
            `---\ntitle: Note ${i}\ntags: [${i % 3 ? "common" : "rare"}]\nupdatedAt: 2026-10-19T00:00:00Z\n---\nBody ${i}\n`,
        )
    const child = Bun.spawn(
        [
            process.execPath,
            "-e",
            `
import { expect } from "bun:test"
const { listNoteListing, listNotesWithBodies, listFolders, listTags } = await import(${JSON.stringify(join(import.meta.dir, "notes.ts"))})
for (const options of [{}, { tag: "rare" }, { folder: "plans" }, { search: "Note 12" }, { folder: "plans", tag: "common", search: "note" }, { tag: "missing" }]) {
    const listing = listNoteListing(options)
    expect(listing.notes).toEqual(listNotesWithBodies(options))
    expect(listing.folders).toEqual(listFolders())
    expect(listing.tags).toEqual(listTags())
}
const start = performance.now()
for (let i = 0; i < 5; i++) { listNotesWithBodies(); listFolders(); listTags() }
const before = performance.now() - start
const afterStart = performance.now()
for (let i = 0; i < 5; i++) listNoteListing()
console.log(JSON.stringify({ notes: 200, iterations: 5, previousListingMs: before, singlePassListingMs: performance.now() - afterStart }))
`,
        ],
        {
            env: {
                ...process.env,
                TASKS_DIR: tasksDir,
                TASKS_NOTES_DIR: notesDir,
            },
            stdout: "pipe",
            stderr: "pipe",
        },
    )
    const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
    ])
    expect(stderr + stdout).not.toContain("error:")
    expect(exitCode).toBe(0)
    console.log(stdout.trim())
})
