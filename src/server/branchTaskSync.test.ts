import { afterAll, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// The workspace is read once, when the server modules load, so it has to point
// at the sandbox before any of them are imported.
const directory = mkdtempSync(join(tmpdir(), "branch-task-sync-"))
const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd: directory })
    expect(result.exitCode).toBe(0)
    return result.stdout.toString().trim()
}
git("init", "-b", "main")
git("config", "user.name", "Branch Sync Test")
git("config", "user.email", "branch-sync-test@example.invalid")
git("commit", "--allow-empty", "-m", "Initial commit")
mkdirSync(join(directory, ".tasks"))
writeFileSync(join(directory, ".git", "info", "exclude"), ".tasks/\n")
writeFileSync(
    join(directory, ".tasks", "tasks.config.json"),
    JSON.stringify({ baseBranch: "main" }),
)
process.env.TASKS_DIR = join(directory, ".tasks")
process.env.TASKS_DB = join(directory, ".tasks", "tasks.db")

const repo = await import("./repo")
const { syncBranchTasks } = await import("./workPackageBranch")

afterAll(() => rmSync(directory, { recursive: true, force: true }))

/** A finished task with one commit of its own, cut from main. */
function finishedTask(workPackageRef: string, file: string) {
    const task = repo.createTask({
        title: `Write ${file}`,
        workPackageRef,
        useGitWorkflow: true,
        branchName: `task/${file}`,
    })
    git("switch", "-c", `task/${file}`, "main")
    writeFileSync(join(directory, file), `${file}\n`)
    git("add", file)
    git("commit", "-m", `Add ${file}`)
    git("switch", "main")
    repo.setStatus(task.ref, "dev_complete")
    return repo.requireTask(task.ref)
}

const subjects = (branch: string) =>
    git("log", "--reverse", "--format=%s", `main..${branch}`)
        .split("\n")
        .filter(Boolean)

test("a branch added after the work is done carries it, and follows its task list", () => {
    const workPackage = repo.createWorkPackage({ name: "Late branch" })
    const first = finishedTask(workPackage.ref, "one.txt")
    const second = finishedTask(workPackage.ref, "two.txt")

    // Added with no task list given: the finished tasks are on it, and in it.
    const branch = repo.createWorkPackageBranch({
        workPackageRef: workPackage.ref,
    })
    expect(branch.taskRefs).toEqual([first.ref, second.ref])
    const added = syncBranchTasks(branch, [])
    expect(added).toEqual({
        merged: [first.ref, second.ref],
        removed: [],
        problems: [],
        failed: [],
    })
    expect(subjects(branch.branchName)).toEqual(["Add one.txt", "Add two.txt"])
    expect(git("branch", "--show-current")).toBe("main")

    // Deselecting a task takes its commits off; the other stays merged.
    const narrowed = repo.setBranchTasks(branch.id, [second.ref])
    expect(syncBranchTasks(narrowed, branch.taskRefs)).toEqual({
        merged: [],
        removed: [first.ref],
        problems: [],
        failed: [],
    })
    expect(subjects(branch.branchName)).toEqual(["Add two.txt"])
    expect(
        Bun.spawnSync(
            [
                "git",
                "merge-base",
                "--is-ancestor",
                second.branchName!,
                branch.branchName,
            ],
            { cwd: directory },
        ).exitCode,
    ).toBe(0)
    expect(repo.findCombinedBranch(branch.branchName)?.taskRefs).toEqual([
        second.ref,
    ])

    // Selecting it again puts its commits back.
    const widened = repo.setBranchTasks(branch.id, [first.ref, second.ref])
    expect(syncBranchTasks(widened, narrowed.taskRefs)).toEqual({
        merged: [first.ref],
        removed: [],
        problems: [],
        failed: [],
    })
    expect(subjects(branch.branchName)).toEqual(["Add two.txt", "Add one.txt"])
    expect(git("branch", "--show-current")).toBe("main")
})
