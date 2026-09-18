import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

/** A throwaway repository with a `tasks` CLI pointed at it. */
function sandbox() {
    const directory = mkdtempSync(join(tmpdir(), "work-package-cli-"))
    const git = (...args: string[]) => {
        const result = Bun.spawnSync(["git", ...args], { cwd: directory })
        expect(result.exitCode).toBe(0)
        return result.stdout.toString().trim()
    }
    git("init", "-b", "main")
    git("config", "user.name", "Work Package Test")
    git("config", "user.email", "work-package-test@example.invalid")
    git("commit", "--allow-empty", "-m", "Initial commit")
    mkdirSync(join(directory, ".tasks"))
    // As `tasks init` does, so the workspace never makes the tree look dirty.
    writeFileSync(join(directory, ".git", "info", "exclude"), ".tasks/\n")
    // Pinned so nothing asks `gh` what the base branch is.
    writeFileSync(
        join(directory, ".tasks", "tasks.config.json"),
        JSON.stringify({ baseBranch: "main" }),
    )
    const spawn = (args: string[]) =>
        Bun.spawnSync(
            [process.execPath, resolve(import.meta.dir, "index.ts"), ...args],
            {
                cwd: directory,
                env: {
                    ...process.env,
                    TASKS_DIR: join(directory, ".tasks"),
                    TASKS_DB: join(directory, ".tasks", "tasks.db"),
                },
            },
        )
    const cli = (...args: string[]) => {
        const result = spawn([...args, "--json"])
        expect(result.stderr.toString()).toBe("")
        expect(result.exitCode).toBe(0)
        return JSON.parse(result.stdout.toString())
    }
    /** For commands with no JSON form, whose output is Git's own. */
    const run = (...args: string[]) => {
        const result = spawn(args)
        expect(result.exitCode).toBe(0)
        return result.stdout.toString()
    }
    return {
        directory,
        git,
        cli,
        run,
        dispose: () => rmSync(directory, { recursive: true, force: true }),
    }
}

test("work package CLI creates, lists, filters and moves tasks", () => {
    const { git, cli, dispose } = sandbox()
    try {
        const first = cli(
            "work-package",
            "new",
            "First package",
            "--brief",
            "Why is it slow?",
            "--with-branch",
        ).workPackage
        expect(first.ref).toBe("WP-1")
        expect(first.investigations[0].brief).toBe("Why is it slow?")
        expect(first.investigations[0].workPackageRef).toBe("WP-1")
        const branch = first.branches[0]
        expect(branch.branchName).toBe("feature/wp-1-first-package")

        // Renaming the tab's branch renames it in Git, keeping its commits.
        git("branch", branch.branchName)
        const originalHead = git("rev-parse", branch.branchName)
        cli(
            "work-package",
            "branch",
            "edit",
            first.ref,
            branch.branchName,
            "--rename",
            "feature/renamed-before-push",
            "--label",
            "Main",
        )
        const shown = cli("work-package", "show", first.ref).workPackage
        expect(shown.branches[0].branchName).toBe("feature/renamed-before-push")
        expect(shown.branches[0].label).toBe("Main")
        expect(git("rev-parse", "feature/renamed-before-push")).toBe(
            originalHead,
        )
        expect(git("branch", "--list", branch.branchName)).toBe("")

        // A new task joins the newest branch.
        const task = cli(
            "new",
            "One task",
            "--work-package",
            first.ref,
            "--no-git",
        ).task
        expect(task.targetBranches).toEqual(["feature/renamed-before-push"])
        const listed = cli("list", "--work-package", first.ref)
        expect(listed.tasks[0].workPackageRef).toBe(first.ref)
        expect(listed.workPackages[0].taskCount).toBe(1)

        // Moving it to another package moves it onto that package's branch.
        const second = cli("group", "new", "Legacy command alias").workPackage
        expect(second.branches).toEqual([])
        cli("work-package", "add", second.ref, "T-1")
        const moved = cli("list", "--group", second.ref).tasks[0]
        expect(moved.workPackageRef).toBe(second.ref)
        expect(moved.targetBranches).toEqual([])
        expect(cli("list", "--work-package", first.ref).tasks).toEqual([])
        cli("work-package", "edit", second.ref, "--name", "Renamed package")
        const packages = cli("work-package", "list").workPackages
        expect(
            packages.find((item: { ref: string }) => item.ref === second.ref)
                .name,
        ).toBe("Renamed package")
    } finally {
        dispose()
    }
})

test("a task on two branches is cut from the first and merged into both", () => {
    const { directory, git, cli, run, dispose } = sandbox()
    try {
        writeFileSync(join(directory, "base.txt"), "base\n")
        git("add", "base.txt")
        git("commit", "-m", "Base file")
        git("branch", "release")
        // Work on main that the release branch must not receive.
        writeFileSync(join(directory, "main-only.txt"), "main\n")
        git("add", "main-only.txt")
        git("commit", "-m", "Main-only work")

        const pkg = cli(
            "work-package",
            "new",
            "Fix",
            "--with-branch",
        ).workPackage
        const task = cli("new", "Patch it", "--work-package", pkg.ref).task
        const release = cli(
            "work-package",
            "branch",
            "add",
            pkg.ref,
            "--existing",
            "release",
            "--label",
            "Release",
        ).branch
        // Every open task is put on a new branch by default.
        expect(release.taskRefs).toEqual([task.ref])
        expect(cli("show", task.ref).task.targetBranches).toEqual([
            pkg.branches[0].branchName,
            "release",
        ])

        expect(run("branch", task.ref)).toContain(`also merges it into release`)
        // Cut from the first target, which was created from main.
        expect(git("log", "--format=%s", "-1")).toBe("Main-only work")
        cli("start", task.ref)
        writeFileSync(join(directory, "fix.txt"), "fixed\n")
        git("add", "fix.txt")
        git("commit", "-m", "The fix")

        const done = cli("done", task.ref)
        expect(done.mergeError).toBeNull()

        const first = pkg.branches[0].branchName
        expect(git("log", "--format=%s", "-1", first)).toBe("The fix")
        // Only the fix reached the release branch, not main's other work.
        expect(git("log", "--format=%s", "main..release")).toBe("The fix")
        expect(git("show", "release:fix.txt")).toBe("fixed")
        expect(
            Bun.spawnSync(["git", "cat-file", "-e", "release:main-only.txt"], {
                cwd: directory,
            }).exitCode,
        ).not.toBe(0)

        // Running the merge again recognises both as done.
        expect(cli("merge", task.ref).mergeError).toBeNull()
        expect(git("log", "--format=%s", "main..release")).toBe("The fix")
    } finally {
        dispose()
    }
})
