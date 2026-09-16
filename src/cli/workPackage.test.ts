import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

test("work package CLI creates, lists, filters and moves tasks", () => {
    const directory = mkdtempSync(join(tmpdir(), "work-package-cli-"))
    try {
        const git = (...args: string[]) => {
            const result = Bun.spawnSync(["git", ...args], { cwd: directory })
            expect(result.stderr.toString()).toBe("")
            expect(result.exitCode).toBe(0)
            return result.stdout.toString().trim()
        }
        git("init", "-b", "main")
        git("config", "user.name", "Work Package Test")
        git("config", "user.email", "work-package-test@example.invalid")
        git("commit", "--allow-empty", "-m", "Initial commit")
        const cli = (...args: string[]) => {
            const result = Bun.spawnSync(
                [
                    process.execPath,
                    resolve(import.meta.dir, "index.ts"),
                    ...args,
                    "--json",
                ],
                {
                    env: {
                        ...process.env,
                        TASKS_DIR: join(directory, ".tasks"),
                        TASKS_DB: join(directory, "tasks.db"),
                    },
                },
            )
            expect(result.stderr.toString()).toBe("")
            expect(result.exitCode).toBe(0)
            return JSON.parse(result.stdout.toString())
        }
        const first = cli("work-package", "new", "First package").workPackage
        expect(first.ref).toBe("WP-1")
        expect(first.branchName).toBe("feature/wp-1-first-package")
        git("branch", first.branchName)
        const originalHead = git("rev-parse", first.branchName)
        cli(
            "work-package",
            "edit",
            first.ref,
            "--branch",
            "feature/renamed-before-push",
        )
        expect(
            cli("work-package", "show", first.ref).workPackage.branchName,
        ).toBe("feature/renamed-before-push")
        expect(git("rev-parse", "feature/renamed-before-push")).toBe(
            originalHead,
        )
        expect(git("branch", "--list", first.branchName)).toBe("")
        cli("new", "One task", "--work-package", first.ref, "--no-git")
        const listed = cli("list", "--work-package", first.ref)
        expect(listed.tasks[0].workPackageRef).toBe(first.ref)
        expect(listed.workPackages[0].taskCount).toBe(1)
        const second = cli("group", "new", "Legacy command alias").workPackage
        cli("work-package", "add", second.ref, "T-1")
        expect(cli("list", "--group", second.ref).tasks[0].workPackageRef).toBe(
            second.ref,
        )
        expect(cli("list", "--work-package", first.ref).tasks).toEqual([])
        cli("work-package", "edit", second.ref, "--name", "Renamed package")
        const packages = cli("work-package", "list").workPackages
        expect(
            packages.find((item: { ref: string }) => item.ref === second.ref)
                .name,
        ).toBe("Renamed package")
    } finally {
        rmSync(directory, { recursive: true, force: true })
    }
})
