import { createHash } from "node:crypto"
import {
    existsSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    realpathSync,
    renameSync,
    rmSync,
    writeFileSync,
} from "node:fs"
import { basename, dirname, join, relative, resolve, sep } from "node:path"
import { workspace } from "../config/paths"
import {
    VISUAL_NOTES_FOLDER,
    type CheckpointRun,
    type TaskVisualSync,
} from "../shared/types"
import { getDb } from "./db"
import { commitNotes, isNotesRepo, slugify } from "./notes"
import { getTaskDetail } from "./repo"

const hash = (value: string | Buffer) =>
    createHash("sha256").update(value).digest("hex")
const portable = (path: string) => path.split(sep).join("/")
const inside = (root: string, path: string) =>
    path === root || path.startsWith(root + sep)

/** Refuse symlinks in generated paths, including intermediate directories. */
function safeDestination(root: string, path: string): void {
    if (!inside(root, path)) throw new Error("Invalid visual export path.")
    let current = root
    for (const part of relative(root, path).split(sep).filter(Boolean)) {
        current = join(current, part)
        if (existsSync(current) && lstatSync(current).isSymbolicLink())
            throw new Error(`Visual export path is a symbolic link: ${current}`)
    }
}

interface ExportedArtifact {
    sourcePath: string
    path: string
    sha256: string
    bytes: number
}

function markdown(value: string): string {
    return value.replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ")
}

/**
 * Archive the task's current on-disk evidence plus every recorded run. aio-vr
 * reuses filenames: the manifest deliberately separates run metadata from
 * current artifact bytes rather than claiming old runs still have old images.
 * Git preserves the artifacts from earlier syncs.
 */
export function syncTaskVisuals(ref: string): TaskVisualSync {
    const ws = workspace()
    const task = getTaskDetail(ref)
    if (!task.runs.length)
        throw new Error(`No visual runs for ${task.ref}. Capture before first.`)
    if (!isNotesRepo())
        throw new Error(
            `${ws.notesDir} is not a Git repository. Run \`tasks notes init\` first.`,
        )

    // Refs repeat across repositories. A shared notes repo needs a namespace.
    const remote = Bun.spawnSync(["git", "remote", "get-url", "origin"], {
        cwd: ws.repoRoot,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
    })
    const identity =
        remote.exitCode === 0 ? remote.stdout.toString().trim() : ws.repoRoot
    const repositoryKey = `${slugify(basename(ws.repoRoot))}-${hash(identity).slice(0, 12)}`
    const path = `${VISUAL_NOTES_FOLDER}/${repositoryKey}/${task.ref}`
    const destination = resolve(ws.notesDir, path)
    safeDestination(ws.notesDir, destination)

    const files = new Map<string, Buffer>()
    const artifacts = new Map<string, ExportedArtifact>()
    const missing = new Set<string>()
    const sourceRoot = resolve(ws.aioVrDir)
    const realSourceRoot = existsSync(sourceRoot)
        ? realpathSync(sourceRoot)
        : sourceRoot

    const addFile = (absolute: string): void => {
        if (!inside(sourceRoot, absolute) || absolute === sourceRoot)
            throw new Error(
                `VR artifact is outside the VR workspace: ${absolute}`,
            )
        const sourcePath = portable(relative(ws.repoRoot, absolute))
        if (!existsSync(absolute)) {
            missing.add(sourcePath)
            return
        }
        if (!inside(realSourceRoot, realpathSync(absolute)))
            throw new Error(
                `VR artifact escapes through a symbolic link: ${sourcePath}`,
            )
        const stat = lstatSync(absolute)
        if (!stat.isFile())
            throw new Error(`VR artifact is not a regular file: ${sourcePath}`)
        const exported = `artifacts/${portable(relative(sourceRoot, absolute))}`
        if (files.has(exported)) return
        const bytes = readFileSync(absolute)
        files.set(exported, bytes)
        artifacts.set(sourcePath, {
            sourcePath,
            path: exported,
            sha256: hash(bytes),
            bytes: bytes.length,
        })
    }

    const walkCheckpoint = (absolute: string): void => {
        if (!inside(sourceRoot, absolute))
            throw new Error("Checkpoint path is outside the VR workspace.")
        if (!existsSync(absolute)) return
        if (
            lstatSync(absolute).isSymbolicLink() ||
            !inside(realSourceRoot, realpathSync(absolute))
        )
            throw new Error(`Checkpoint contains a symbolic link: ${absolute}`)
        if (lstatSync(absolute).isDirectory()) {
            for (const entry of readdirSync(absolute).sort())
                walkCheckpoint(join(absolute, entry))
        } else addFile(absolute)
    }

    const rawRows = getDb()
        .query<{ id: number; raw_json: string | null }, [number]>(
            "SELECT id, raw_json FROM checkpoint_runs WHERE task_id = ? ORDER BY id",
        )
        .all(task.id)
    const rawById = new Map(
        rawRows.map((row) => [
            row.id,
            row.raw_json ? (JSON.parse(row.raw_json) as unknown) : null,
        ]),
    )

    for (const name of new Set(task.runs.map((run) => run.checkpointName))) {
        const checkpoint = resolve(sourceRoot, "checkpoints", name)
        if (
            !inside(join(sourceRoot, "checkpoints"), checkpoint) ||
            checkpoint === join(sourceRoot, "checkpoints")
        )
            throw new Error(`Invalid checkpoint name '${name}'.`)
        walkCheckpoint(checkpoint)
    }
    for (const run of task.runs) {
        for (const comparison of run.comparisons) {
            for (const source of [
                comparison.beforePath,
                comparison.afterPath,
                comparison.diffPath,
            ])
                if (source) addFile(resolve(ws.repoRoot, source))
        }
        const raw = rawById.get(run.id) as {
            scenarios?: { scenarioPath?: string }[]
        } | null
        // Include scenario definitions for viewport, URL, selectors, and steps.
        for (const scenario of raw?.scenarios ?? []) {
            if (scenario.scenarioPath) {
                // aio-vr records these relative to its scenarios directory,
                // whereas comparison image paths are relative to the repo.
                addFile(resolve(sourceRoot, "scenarios", scenario.scenarioPath))
            }
        }
    }
    const imageSources = new Set(
        task.runs.flatMap((run) =>
            run.comparisons.flatMap((item) =>
                [item.beforePath, item.afterPath, item.diffPath].filter(
                    (value): value is string => !!value,
                ),
            ),
        ),
    )
    if (
        ![...imageSources].some((source) =>
            artifacts.has(
                portable(relative(ws.repoRoot, resolve(ws.repoRoot, source))),
            ),
        )
    )
        throw new Error(
            `No screenshots remain on disk for ${task.ref}. Capture again before syncing. Any previous export has been kept.`,
        )

    const exportedArtifacts = [...artifacts.values()].sort((a, b) =>
        a.path.localeCompare(b.path),
    )
    const missingArtifacts = [...missing].sort()
    const latest = new Map<CheckpointRun["phase"], CheckpointRun>()
    for (const run of task.runs) latest.set(run.phase, run)
    const after = latest.get("after")
    const completePixelCounts =
        !!after?.comparisons.length &&
        after.comparisons.every(
            (item) => item.pixelDiffCount !== null && item.totalPixels !== null,
        )
    const pixelDiffCount = completePixelCounts
        ? after!.comparisons.reduce(
              (sum, item) => sum + item.pixelDiffCount!,
              0,
          )
        : null
    const totalPixels = completePixelCounts
        ? after!.comparisons.reduce((sum, item) => sum + item.totalPixels!, 0)
        : null
    const summary = {
        afterRunId: after?.id ?? null,
        scenarioCount: after?.comparisons.length ?? 0,
        changedScenarios:
            after?.comparisons.filter((item) => item.status === "changed")
                .length ?? 0,
        pixelDiffCount,
        totalPixels,
        // Weight by pixel counts; averaging scenario percentages would give
        // screenshots of different sizes the same weight.
        percentChanged:
            totalPixels && pixelDiffCount !== null
                ? (pixelDiffCount / totalPixels) * 100
                : null,
    }
    const manifest = {
        schemaVersion: 1,
        repository: { key: repositoryKey, name: basename(ws.repoRoot) },
        task,
        summary,
        runs: task.runs.map((run) => ({
            ...run,
            raw: rawById.get(run.id) ?? null,
        })),
        artifacts: exportedArtifacts,
        missingArtifacts,
        artifactSemantics:
            "Artifacts are current on-disk files at sync time. aio-vr may reuse paths between runs; historical run metadata does not imply historical image bytes. Earlier exports are available in notes Git history.",
    }
    files.set(
        "manifest.json",
        Buffer.from(JSON.stringify(manifest, null, 2) + "\n"),
    )

    const link = (source: string | null, label: string): string => {
        if (!source) return "—"
        const item = artifacts.get(
            portable(relative(ws.repoRoot, resolve(ws.repoRoot, source))),
        )
        return item
            ? `[${label}](${item.path.split("/").map(encodeURIComponent).join("/")})`
            : "Missing"
    }
    const report = [
        `# ${task.ref}: ${task.title}`,
        "",
        task.description,
        "",
        `Status: ${task.status} · Priority: ${task.priority} · Work package: ${task.workPackageRef ?? "none"}`,
        `Task branch: ${task.branchName ?? "none"} · Target branches: ${task.targetBranches.join(", ") || "none"}`,
        "",
        `[Full task, run metadata, raw results, and artifact checksums](manifest.json)`,
        "",
        manifest.artifactSemantics,
        "",
    ]
    if (after)
        report.push(
            `Latest comparison: ${summary.changedScenarios} of ${summary.scenarioCount} scenarios changed. Overall pixels changed: ${summary.percentChanged ?? "unavailable"}${summary.percentChanged === null ? "" : "%"}.`,
            "",
        )
    for (const run of latest.values()) {
        report.push(
            `## Latest ${run.phase} capture`,
            "",
            `Run ${run.id} · ${run.createdAt} · Checkpoint: ${run.checkpointName} · Exit code: ${run.exitCode}`,
            `Git HEAD: ${run.gitHead ?? "unknown"} · Dirty: ${run.gitDirty === null ? "unknown" : !!run.gitDirty}`,
            "",
            "| Scenario | Status | Pixels changed (%) | Changed pixels | Total pixels | Before | After | Diff | Browser logs |",
            "| --- | --- | ---: | ---: | ---: | --- | --- | --- | --- |",
            ...run.comparisons.map(
                (item) =>
                    `| ${markdown(item.scenario)} | ${item.status} | ${item.percentChanged ?? "—"} | ${item.pixelDiffCount ?? "—"} | ${item.totalPixels ?? "—"} | ${link(item.beforePath, "Before")} | ${link(item.afterPath, "After")} | ${link(item.diffPath, "Diff")} | ${markdown(item.browserLogStatus ?? "—")} (${item.browserLogChangeCount ?? "—"}) |`,
            ),
            "",
        )
    }
    if (missingArtifacts.length)
        report.push(
            "## Missing source files",
            "",
            ...missingArtifacts.map((item) => `- ${item}`),
            "",
        )
    files.set("README.md", Buffer.from(report.join("\n")))

    // Build completely before replacing the previous export. Unchanged exports
    // do not create commits merely because the button was pressed again.
    mkdirSync(dirname(destination), { recursive: true })
    const temporary = mkdtempSync(join(dirname(destination), ".visual-sync-"))
    const backup = `${temporary}-previous`
    let published = false
    try {
        for (const [name, bytes] of files) {
            const target = join(temporary, name)
            mkdirSync(dirname(target), { recursive: true })
            writeFileSync(target, bytes)
        }
        if (existsSync(destination)) renameSync(destination, backup)
        try {
            renameSync(temporary, destination)
            published = true
        } catch (error) {
            if (existsSync(backup)) renameSync(backup, destination)
            throw error
        }
    } finally {
        rmSync(temporary, { recursive: true, force: true })
        if (published) rmSync(backup, { recursive: true, force: true })
    }
    return {
        ref: task.ref,
        path,
        reportPath: `${path}/README.md`,
        fileCount: exportedArtifacts.length,
        missingArtifacts,
        committed: commitNotes(
            `visual-regression: sync ${task.ref} — ${task.title}`,
            [path],
        ),
    }
}
