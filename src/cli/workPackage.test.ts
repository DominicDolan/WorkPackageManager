import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
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

test("task branches start from a freshly fetched base", () => {
    for (const withPackage of [false, true]) {
        const { directory, git, cli, run, dispose } = sandbox()
        try {
            const remote = join(directory, ".tasks", "remote.git")
            git("init", "--bare", remote)
            git("remote", "add", "origin", remote)
            git("push", "-u", "origin", "main")
            const old = git("rev-parse", "main")
            git("commit", "--allow-empty", "-m", "Remote update")
            const latest = git("rev-parse", "main")
            git("push", "origin", "main")
            git("update-ref", "refs/heads/main", old)

            const pkg = cli(
                "work-package",
                "new",
                "Fresh base",
                ...(withPackage ? ["--with-branch"] : []),
            ).workPackage
            const task = cli(
                "new",
                "Fresh task",
                "--work-package",
                pkg.ref,
            ).task
            run("branch", task.ref)
            expect(git("rev-parse", "main")).toBe(latest)
            expect(git("rev-parse", "HEAD")).toBe(latest)
            if (withPackage)
                expect(git("rev-parse", pkg.branches[0].branchName)).toBe(
                    latest,
                )
        } finally {
            dispose()
        }
    }
})

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

test("a task cut from its second target replays only its own commits onto the first", () => {
    const { directory, git, cli, run, dispose } = sandbox()
    try {
        const pkg = cli(
            "work-package",
            "new",
            "Planner",
            "--with-branch",
        ).workPackage
        const first = pkg.branches[0].branchName
        // The first target is stale: cut before main moved on.
        git("branch", first)
        const staleTip = git("rev-parse", first)

        // Main moves on, including a merge commit, which a plain rebase flattens.
        git("switch", "-c", "side")
        writeFileSync(join(directory, "side.txt"), "side\n")
        git("add", "side.txt")
        git("commit", "-m", "Side work")
        git("switch", "main")
        git("merge", "--no-ff", "side", "-m", "Merge side")
        git("branch", "next")

        const task = cli("new", "Workload", "--work-package", pkg.ref).task
        cli(
            "work-package",
            "branch",
            "add",
            pkg.ref,
            "--existing",
            "next",
            "--label",
            "Next",
        )
        expect(cli("show", task.ref).task.targetBranches).toEqual([
            first,
            "next",
        ])

        run("branch", task.ref, "--from", "next")
        cli("start", task.ref)
        writeFileSync(join(directory, "workload.txt"), "workload\n")
        git("add", "workload.txt")
        git("commit", "-m", "The workload")

        const done = cli("done", task.ref)
        expect(done.mergeError).toBeNull()
        expect(cli("show", task.ref).task.gitError).toBeNull()

        // The stale branch gained the task's one commit, not copies of main's.
        expect(git("log", "--format=%s", `${staleTip}..${first}`)).toBe(
            "The workload",
        )
        // And the second target got it too, on top of main's real history.
        expect(git("log", "--format=%s", "main..next")).toBe("The workload")
        expect(git("rev-list", "--merges", "main", "-1")).not.toBe("")
    } finally {
        dispose()
    }
})

test("a target branch that already has a pull request is left out while another has none", () => {
    const { directory, git, cli, run, dispose } = sandbox()
    try {
        const pkg = cli(
            "work-package",
            "new",
            "Import",
            "--with-branch",
        ).workPackage
        const shipped = pkg.branches[0].branchName
        // The first branch went out as a PR, and main moved on after it.
        git("branch", shipped)
        const shippedTip = git("rev-parse", shipped)
        writeFileSync(join(directory, "later.txt"), "later\n")
        git("add", "later.txt")
        git("commit", "-m", "Later work on main")
        git("branch", "next")

        const task = cli("new", "Follow-up", "--work-package", pkg.ref).task
        cli(
            "work-package",
            "branch",
            "add",
            pkg.ref,
            "--existing",
            "next",
            "--label",
            "Next",
        )
        expect(cli("show", task.ref).task.targetBranches).toEqual([
            shipped,
            "next",
        ])
        // As \`tasks\` records it when it opens the PR.
        const db = new Database(join(directory, ".tasks", "tasks.db"))
        const at = new Date().toISOString()
        db.query(
            `INSERT INTO combined_branches (branch_name, base_branch, pr_url, pr_number, created_at, updated_at)
             VALUES ($name, 'main', 'https://example.invalid/pull/1', 1, $at, $at)
             ON CONFLICT(branch_name) DO UPDATE SET pr_url = 'https://example.invalid/pull/1', pr_number = 1`,
        ).run({ $name: shipped, $at: at })
        db.close()

        // Cut from the branch without a PR, so it has main's later work.
        expect(run("branch", task.ref)).not.toContain("also merges it into")
        expect(git("log", "--format=%s", "-1")).toBe("Later work on main")
        cli("start", task.ref)
        writeFileSync(join(directory, "follow.txt"), "follow\n")
        git("add", "follow.txt")
        git("commit", "-m", "The follow-up")

        const done = cli("done", task.ref)
        expect(done.mergeError).toBeNull()
        expect(git("log", "--format=%s", "main..next")).toBe("The follow-up")
        // The PR's branch is untouched.
        expect(git("rev-parse", shipped)).toBe(shippedTip)
        // And the task reads as merged everywhere it still has to go.
        expect(cli("merge", task.ref).mergeError).toBeNull()
        expect(git("rev-parse", shipped)).toBe(shippedTip)
    } finally {
        dispose()
    }
})

test("a failed merge into a target branch is recorded on the task", () => {
    const { directory, git, cli, run, dispose } = sandbox()
    try {
        writeFileSync(join(directory, "shared.txt"), "base\n")
        git("add", "shared.txt")
        git("commit", "-m", "Base")
        const pkg = cli(
            "work-package",
            "new",
            "Clash",
            "--with-branch",
        ).workPackage
        const first = pkg.branches[0].branchName
        const task = cli("new", "Edit shared", "--work-package", pkg.ref).task
        run("branch", task.ref)
        cli("start", task.ref)
        writeFileSync(join(directory, "shared.txt"), "from the task\n")
        git("commit", "-am", "Task edit")

        // Someone else changes the same line on the target meanwhile.
        git("switch", first)
        writeFileSync(join(directory, "shared.txt"), "from elsewhere\n")
        git("commit", "-am", "Other edit")
        git("switch", task.branchName ?? cli("show", task.ref).task.branchName)

        const done = cli("done", task.ref)
        expect(done.mergeError).toContain(first)
        const recorded = cli("show", task.ref).task.gitError
        expect(recorded.message).toContain(first)
        expect(typeof recorded.at).toBe("string")
    } finally {
        dispose()
    }
})
