import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

test("background checks publish partial results and per-command start times, then resume after a fix", () => {
    const directory = mkdtempSync(join(tmpdir(), "checks-progress-"))
    try {
        const git = (...args: string[]) => {
            const result = Bun.spawnSync(["git", ...args], { cwd: directory })
            expect(result.exitCode).toBe(0)
        }
        git("init", "-b", "main")
        git(
            "-c",
            "user.name=Checks Test",
            "-c",
            "user.email=checks@example.invalid",
            "commit",
            "--allow-empty",
            "-m",
            "Initial",
        )
        mkdirSync(join(directory, ".tasks"))
        writeFileSync(
            join(directory, ".tasks", "tasks.config.json"),
            JSON.stringify({
                baseBranch: "main",
                checks: [
                    {
                        name: "first",
                        command: [
                            process.execPath,
                            "-e",
                            "await Bun.sleep(100); console.log('first passed')",
                        ],
                    },
                    {
                        name: "second",
                        command: [
                            process.execPath,
                            "-e",
                            "await Bun.sleep(200); process.exit(require('node:fs').existsSync('fixed') ? 0 : 1)",
                        ],
                    },
                    {
                        name: "third",
                        command: [
                            process.execPath,
                            "-e",
                            "await Bun.sleep(100); console.log('third passed')",
                        ],
                    },
                ],
            }),
        )
        // Isolate workspace()/database singletons from the rest of the test suite.
        const result = Bun.spawnSync(
            [
                process.execPath,
                "-e",
                `
            import { strict as assert } from "node:assert";
            import { writeFileSync } from "node:fs";
            import { startChecks, checksProgress, runChecks, headSha } from ${JSON.stringify(join(import.meta.dir, "checks.ts"))};
            const progress = startChecks({ branch: "main", base: "main" });
            assert.equal(progress.current, "first");
            assert.ok(progress.currentStartedAt);
            const firstStarted = progress.currentStartedAt;
            const deadline = Date.now() + 4000;
            while (checksProgress("main") && !progress.checks.length && Date.now() < deadline) await Bun.sleep(10);
            assert.equal(progress.current, "second");
            assert.notEqual(progress.currentStartedAt, firstStarted);
            assert.equal(progress.checks[0].status, "passed");
            assert.ok(progress.checks[0].durationMs >= 100);
            assert.equal(progress.done, 1);
            assert.equal(progress.total, 3);
            while (checksProgress("main") && Date.now() < deadline) await Bun.sleep(10);
            assert.equal(checksProgress("main"), null);
            assert.deepEqual(progress.checks.map(r => r.status), ["passed", "failed"]);
            assert.equal(progress.currentStartedAt, null);
            const previous = { branch: "main", base: "main", headSha: headSha("main"),
                ranAt: new Date().toISOString(), passed: false, ranOnBranch: "main", checks: progress.checks };
            writeFileSync("fixed", "yes");
            const started = [];
            const resumed = await runChecks({ branch: "main", base: "main", previous, resume: true,
                onProgress: name => started.push(name) });
            assert.deepEqual(started, ["second", "third"]);
            assert.equal(resumed.passed, true);
            assert.deepEqual(resumed.checks.map(r => r.name), ["first", "second", "third"]);
            assert.equal(resumed.checks[0].durationMs, previous.checks[0].durationMs);
            console.log("progress and resume passed");
        `,
            ],
            {
                cwd: directory,
                env: {
                    ...process.env,
                    TASKS_DIR: join(directory, ".tasks"),
                    TASKS_DB: join(directory, ".tasks", "tasks.db"),
                },
                timeout: 8000,
            },
        )
        expect(result.stderr.toString()).toBe("")
        expect(result.exitCode).toBe(0)
        expect(result.stdout.toString()).toContain("progress and resume passed")
    } finally {
        rmSync(directory, { recursive: true, force: true })
    }
})
