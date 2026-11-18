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

test("a Claude usage limit hands an unattended task to Codex", () => {
    const directory = mkdtempSync(join(tmpdir(), "usage-fallback-"))
    try {
        const bin = join(directory, "bin")
        mkdirSync(bin)
        mkdirSync(join(directory, ".tasks"))
        writeFileSync(join(directory, ".tasks", "tasks.config.json"), "{}")
        const script = (name: string, body: string) => {
            const path = join(bin, name)
            writeFileSync(path, `#!/bin/sh\n${body}\n`)
            chmodSync(path, 0o755)
        }
        script(
            "tasks",
            `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(import.meta.dir, "../cli/index.ts"))} "$@"`,
        )
        script(
            "claude",
            `echo '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","rateLimitType":"five_hour","resetsAt":1794323400}}'\nexit 1`,
        )
        script("codex", "tasks start T-1 >&2 && tasks done T-1 >&2\necho done")
        const result = Bun.spawnSync(
            [
                process.execPath,
                "-e",
                `
            import { strict as assert } from "node:assert";
            import { createWorkPackage, createTask, requireWorkPackageRun } from ${JSON.stringify(join(import.meta.dir, "repo.ts"))};
            import { startWorkRun, workRunDetail, requireWorkRun } from ${JSON.stringify(join(import.meta.dir, "workRuns.ts"))};
            import { findAgentRun } from ${JSON.stringify(join(import.meta.dir, "agents.ts"))};
            const wp = createWorkPackage({ name: "Fallback" });
            createTask({ title: "Task", workPackageRef: wp.ref, useGitWorkflow: false });
            const started = startWorkRun({ workPackageRef: wp.ref, kind: "unattended", harness: "claude", model: "", mode: "print", permissionMode: "bypassPermissions", extra: "", fallback: "codex" });
            const deadline = Date.now() + 10000;
            let detail;
            do { await Bun.sleep(20); detail = workRunDetail(requireWorkRun(started.id)); assert.ok(Date.now() < deadline); } while (detail.status === "running");
            assert.equal(detail.status, "finished", detail.statusDetail);
            const loop = requireWorkPackageRun(detail.workPackageRunId);
            assert.equal(loop.fallback, "codex");
            assert.equal(loop.harness, "codex");
            assert.equal(loop.runIds.length, 2);
            assert.equal(findAgentRun(loop.runIds[1]).harness, "codex");
            process.exit(0);
        `,
            ],
            {
                cwd: directory,
                env: {
                    ...process.env,
                    PATH: `${bin}:${process.env.PATH}`,
                    TASKS_DIR: join(directory, ".tasks"),
                    TASKS_DB: join(directory, ".tasks", "tasks.db"),
                },
                timeout: 15000,
            },
        )
        expect(result.stderr.toString()).toBe("")
        expect(result.exitCode).toBe(0)
    } finally {
        rmSync(directory, { recursive: true, force: true })
    }
}, 20000)
