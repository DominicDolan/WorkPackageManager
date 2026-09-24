import { expect, test } from "bun:test"
import {
    chmodSync,
    mkdirSync,
    mkdtempSync,
    rmSync,
    writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

test("a supervised rebase is judged by Git: resolved and finished counts, giving up does not", () => {
    const directory = mkdtempSync(join(tmpdir(), "rebase-supervisor-"))
    try {
        const git = (...args: string[]) => {
            const result = Bun.spawnSync(["git", ...args], { cwd: directory })
            expect(result.exitCode).toBe(0)
        }
        git("init", "-b", "main")
        git("config", "user.name", "Rebase Test")
        git("config", "user.email", "rebase@example.invalid")
        writeFileSync(join(directory, ".gitignore"), ".tasks/\nbin/\n")
        writeFileSync(join(directory, "shared.txt"), "base\n")
        git("add", ".")
        git("commit", "-m", "Initial")
        // Two branches that change the same line, so rebasing one onto the
        // other conflicts.
        for (const branch of ["resolvable", "hopeless"]) {
            git("switch", "-c", branch, "main")
            writeFileSync(join(directory, "shared.txt"), `${branch}\n`)
            git("commit", "-am", branch)
        }
        git("switch", "main")
        writeFileSync(join(directory, "shared.txt"), "main\n")
        git("commit", "-am", "Main moves on")

        // Stands in for an agent harness. It resolves `resolvable`'s rebase by
        // keeping both sides, and gives up on `hopeless`, as it is told to.
        mkdirSync(join(directory, "bin"))
        const agent = join(directory, "bin", "pi")
        writeFileSync(
            agent,
            [
                "#!/bin/sh",
                "for last; do :; done",
                'case "$last" in',
                '  *"Bring branch `resolvable`"*)',
                "    git rebase main resolvable >&2",
                "    printf 'main\\nresolvable\\n' > shared.txt && git add shared.txt",
                "    GIT_EDITOR=true git rebase --continue >&2",
                '    echo "Kept both sides." ;;',
                '  *) echo "Cannot settle this; left it as it was." ;;',
                "esac",
            ].join("\n"),
        )
        chmodSync(agent, 0o755)
        mkdirSync(join(directory, ".tasks"))
        writeFileSync(
            join(directory, ".tasks", "tasks.config.json"),
            JSON.stringify({ baseBranch: "main" }),
        )

        // Isolate workspace()/database singletons from the rest of the suite.
        const result = Bun.spawnSync(
            [
                process.execPath,
                "-e",
                `
            import { strict as assert } from "node:assert";
            import { superviseRebaseConflict, rebaseSupervision } from ${JSON.stringify(join(import.meta.dir, "rebaseSupervisor.ts"))};
            import { currentBranch, isAncestor } from ${JSON.stringify(join(import.meta.dir, "branches.ts"))};
            const supervisor = { harness: "pi", model: "", permissionMode: "bypassPermissions", extra: "" };
            const supervise = async (branch) => {
                const started = superviseRebaseConflict({ supervisor, pushed: false, from: "main",
                    conflict: { operation: "rebase", scope: "repo", branch, onto: "main",
                        files: ["shared.txt"], detail: "CONFLICT (content)" } });
                assert.equal(started.status, "resolving");
                const deadline = Date.now() + 15000;
                for (;;) {
                    const state = rebaseSupervision(branch);
                    if (state.status !== "resolving") return state;
                    assert.ok(Date.now() < deadline, "supervision did not settle");
                    await Bun.sleep(20);
                }
            };

            const resolved = await supervise("resolvable");
            assert.equal(resolved.status, "rebased", resolved.stopReason);
            assert.equal(resolved.agent.command, "resolve-conflicts");
            assert.ok(isAncestor("main", "resolvable"));
            assert.equal(currentBranch(), "main", "the working tree goes back where it was");

            const hopeless = await supervise("hopeless");
            assert.equal(hopeless.status, "blocked");
            assert.match(hopeless.stopReason, /could not rebase 'hopeless' onto 'main'/);
            assert.ok(!isAncestor("main", "hopeless"));
            console.log("judged by git");
            process.exit(0);
        `,
            ],
            {
                cwd: directory,
                env: {
                    ...process.env,
                    PATH: `${join(directory, "bin")}:${process.env.PATH}`,
                    TASKS_DIR: join(directory, ".tasks"),
                    TASKS_DB: join(directory, ".tasks", "tasks.db"),
                },
                timeout: 20000,
            },
        )
        expect(result.stderr.toString()).toBe("")
        expect(result.exitCode).toBe(0)
        expect(result.stdout.toString()).toContain("judged by git")
    } finally {
        rmSync(directory, { recursive: true, force: true })
    }
})
