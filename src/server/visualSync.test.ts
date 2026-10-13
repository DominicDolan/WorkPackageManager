import { afterAll, expect, test } from "bun:test"
import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

const directory = mkdtempSync(join(tmpdir(), "task-visual-sync-"))
const tasksDir = join(directory, ".tasks")
const notesDir = join(directory, ".notes")
mkdirSync(tasksDir)
mkdirSync(notesDir)
process.env.TASKS_DIR = tasksDir
process.env.TASKS_DB = join(tasksDir, "tasks.db")
process.env.TASKS_NOTES_DIR = notesDir
process.env.AIO_VR_DIR = join(directory, ".aio-vr")

function git(...args: string[]) {
    const result = Bun.spawnSync(["git", ...args], { cwd: notesDir })
    expect(result.exitCode).toBe(0)
    return result.stdout.toString().trim()
}
git("init", "-b", "main")
git("config", "user.name", "Visual Sync Test")
git("config", "user.email", "visual-sync@example.invalid")

const { createTask, createWorkPackage, getTaskDetail, recordRun } =
    await import("./repo")
const { syncTaskVisuals } = await import("./visualSync")
const workPackage = createWorkPackage({ name: "Visual sync tests" })
afterAll(() => rmSync(directory, { recursive: true, force: true }))

function source(path: string, content = path) {
    mkdirSync(dirname(join(directory, path)), { recursive: true })
    writeFileSync(join(directory, path), content)
    return path
}

function capture(title: string, after = false) {
    const task = createTask({
        title,
        description: "Visual task details",
        useGitWorkflow: false,
        workPackageRef: workPackage.ref,
    })
    const checkpoint = `.aio-vr/checkpoints/${task.checkpointName}`
    const beforePath = source(`${checkpoint}/images/page.png`, "before image")
    const scenarioPath = `page-${task.id}.cjs`
    source(
        `.aio-vr/scenarios/${scenarioPath}`,
        "module.exports = { url: 'http://localhost:3000' }",
    )
    const raw = {
        name: task.checkpointName,
        scenarios: [
            {
                name: "page",
                scenarioPath,
                viewport: { width: 1280, height: 720 },
            },
        ],
    }
    source(`${checkpoint}/meta.json`, JSON.stringify(raw))
    const comparison = {
        scenario: "page",
        description: "Page description",
        status: "new-baseline" as const,
        percentChanged: null,
        pixelDiffCount: null,
        totalPixels: null,
        beforePath,
        afterPath: null,
        diffPath: null,
        browserLogStatus: null,
        browserLogChangeCount: null,
    }
    const input = {
        taskId: task.id,
        checkpointName: task.checkpointName!,
        phase: "before" as const,
        exitCode: 0,
        gitHead: "abc123",
        gitDirty: true,
        scenarioCount: 1,
        selection: { scenarios: ["page"] },
        raw,
        comparisons: [comparison],
    }
    recordRun(input)
    if (after) {
        const result = {
            ...comparison,
            status: "changed" as const,
            percentChanged: 12.345,
            pixelDiffCount: 12345,
            totalPixels: 100000,
            afterPath: source(
                `${checkpoint}/runs/page.actual.png`,
                "after image",
            ),
            diffPath: source(`${checkpoint}/runs/page.diff.png`, "diff image"),
            browserLogStatus: "changed",
            browserLogChangeCount: 2,
        }
        const rawAfter = {
            generatedAt: "2026-10-07T12:00:00Z",
            results: [{ ...result, extraFutureField: "preserved" }],
        }
        source(`${checkpoint}/results.json`, JSON.stringify(rawAfter))
        source(
            `${checkpoint}/runs/page.browser-logs.json`,
            '{"requests":["GET /page"]}',
        )
        recordRun({
            ...input,
            phase: "after",
            comparisons: [result],
            raw: rawAfter,
        })
    }
    return task
}

test("exports before-only evidence and commits only this task, preserving other staged notes", () => {
    writeFileSync(join(notesDir, "unrelated.md"), "Do not commit this note")
    git("add", "unrelated.md")
    const task = capture("Before only")
    const sync = syncTaskVisuals(task.ref.toLowerCase())
    expect(sync.ref).toBe(task.ref)
    expect(sync.committed).not.toBeNull()
    expect(sync.missingArtifacts).toEqual([])
    expect(readFileSync(join(notesDir, sync.reportPath), "utf8")).toContain(
        "Latest before capture",
    )
    const changed = git("show", "--pretty=", "--name-only", "HEAD").split("\n")
    expect(changed.every((path) => path.startsWith(sync.path + "/"))).toBe(true)
    expect(git("diff", "--cached", "--name-only")).toBe("unrelated.md")
    expect(syncTaskVisuals(task.ref).committed).toBeNull()
})

test("exports portable screenshots, metrics, raw data, scenario definitions, and browser logs", () => {
    const task = capture("Before and after", true)
    const sync = syncTaskVisuals(task.ref)
    const root = join(notesDir, sync.path)
    const manifest = JSON.parse(
        readFileSync(join(root, "manifest.json"), "utf8"),
    )
    expect(manifest.task.description).toBe("Visual task details")
    expect(manifest.task.events).toHaveLength(3)
    expect(manifest.runs).toHaveLength(2)
    expect(manifest.runs[0].raw.scenarios[0].viewport).toEqual({
        width: 1280,
        height: 720,
    })
    expect(manifest.runs[1].comparisons[0].percentChanged).toBe(12.345)
    expect(manifest.runs[1].comparisons[0].pixelDiffCount).toBe(12345)
    expect(manifest.summary.percentChanged).toBeCloseTo(12.345)
    expect(manifest.summary.changedScenarios).toBe(1)
    expect(manifest.runs[1].selection).toEqual({ scenarios: ["page"] })
    expect(manifest.runs[1].raw.results[0].extraFutureField).toBe("preserved")
    const report = readFileSync(join(root, "README.md"), "utf8")
    expect(report).toContain("12.345")
    expect(report).toContain("12345")
    expect(report).toContain("100000")
    for (const item of manifest.artifacts) {
        const bytes = readFileSync(join(root, item.path))
        expect(bytes.length).toBe(item.bytes)
        expect(new Bun.CryptoHasher("sha256").update(bytes).digest("hex")).toBe(
            item.sha256,
        )
        expect(item.path).not.toContain(directory)
    }
    expect(
        manifest.artifacts.some((item: { path: string }) =>
            item.path.endsWith("browser-logs.json"),
        ),
    ).toBe(true)
    expect(
        manifest.artifacts.some((item: { path: string }) =>
            item.path.endsWith(".cjs"),
        ),
    ).toBe(true)
    const other = capture("Another task")
    const otherSync = syncTaskVisuals(other.ref)
    expect(otherSync.path).not.toBe(sync.path)
    expect(git("show", "--pretty=", "--name-only", "HEAD")).not.toContain(
        sync.path,
    )
})

test("changed evidence creates a new commit and old screenshots remain in Git history", () => {
    const task = capture("Capture again", true)
    const first = syncTaskVisuals(task.ref)
    const afterPath = getTaskDetail(task.ref).runs[1]!.comparisons[0]!
        .afterPath!
    source(afterPath, "updated image")
    const second = syncTaskVisuals(task.ref)
    expect(second.committed).not.toBe(first.committed)
    expect(
        git(
            "show",
            `${first.committed}:${first.path}/artifacts/checkpoints/${task.checkpointName}/runs/page.actual.png`,
        ),
    ).toBe("after image")
})

test("reports missing files and keeps the previous export when all screenshots are gone", () => {
    const task = capture("Cleaned evidence", true)
    const sync = syncTaskVisuals(task.ref)
    const detail = getTaskDetail(task.ref)
    const diff = detail.runs[1]!.comparisons[0]!.diffPath!
    rmSync(join(directory, diff))
    const partial = syncTaskVisuals(task.ref)
    expect(partial.missingArtifacts).toEqual([diff])
    expect(readFileSync(join(notesDir, sync.reportPath), "utf8")).toContain(
        "Missing source files",
    )
    const previousManifest = readFileSync(
        join(notesDir, sync.path, "manifest.json"),
        "utf8",
    )
    rmSync(join(directory, ".aio-vr", "checkpoints", task.checkpointName!), {
        recursive: true,
    })
    expect(() => syncTaskVisuals(task.ref)).toThrow("No screenshots remain")
    expect(
        readFileSync(join(notesDir, sync.path, "manifest.json"), "utf8"),
    ).toBe(previousManifest)
})

test("rejects missing tasks, missing runs, path escapes, and symlinks without exporting", () => {
    expect(() => syncTaskVisuals("T-999999")).toThrow("No task")
    const noRuns = createTask({
        title: "No capture",
        useGitWorkflow: false,
        workPackageRef: workPackage.ref,
    })
    expect(() => syncTaskVisuals(noRuns.ref)).toThrow("No visual runs")
    const task = capture("Unsafe path")
    const run = getTaskDetail(task.ref).runs[0]!
    recordRun({
        ...run,
        gitDirty: false,
        raw: {},
        comparisons: [
            { ...run.comparisons[0]!, beforePath: "../../outside.png" },
        ],
    })
    expect(() => syncTaskVisuals(task.ref)).toThrow("outside the VR workspace")
    const linked = capture("Symlink")
    const image = getTaskDetail(linked.ref).runs[0]!.comparisons[0]!.beforePath!
    const outside = source("outside.png", "private image")
    rmSync(join(directory, image))
    symlinkSync(join(directory, outside), join(directory, image))
    expect(() => syncTaskVisuals(linked.ref)).toThrow("symbolic link")
})

test("keeps exported files when a Git commit fails so retry can commit them", () => {
    const task = capture("Commit retry")
    const hook = join(notesDir, ".git", "hooks", "pre-commit")
    writeFileSync(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 })
    expect(() => syncTaskVisuals(task.ref)).toThrow()
    rmSync(hook)
    const retry = syncTaskVisuals(task.ref)
    expect(retry.committed).not.toBeNull()
    expect(readFileSync(join(notesDir, retry.reportPath), "utf8")).toContain(
        task.title,
    )
})

test("CLI supports a per-task JSON sync without capturing or pushing", () => {
    const task = capture("CLI sync")
    const result = Bun.spawnSync(
        [
            process.execPath,
            join(import.meta.dir, "../cli/index.ts"),
            "checkpoint",
            "sync",
            task.ref,
            "--json",
        ],
        { env: process.env, cwd: directory },
    )
    expect(result.exitCode).toBe(0)
    expect(result.stderr.toString()).toBe("")
    const { sync } = JSON.parse(result.stdout.toString())
    expect(sync.ref).toBe(task.ref)
    expect(sync.committed).not.toBeNull()
    expect(sync.missingArtifacts).toEqual([])
})
