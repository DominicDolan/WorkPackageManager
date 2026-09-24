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

test("a supervised checks run hands a failure to the supervisor, resumes after its commit, and stops at the per-check cap", () => {
    const directory = mkdtempSync(join(tmpdir(), "checks-supervisor-"))
    try {
        const git = (...args: string[]) => {
            const result = Bun.spawnSync(["git", ...args], { cwd: directory })
            expect(result.exitCode).toBe(0)
        }
        git("init", "-b", "main")
        git("config", "user.name", "Checks Test")
        git("config", "user.email", "checks@example.invalid")
        writeFileSync(join(directory, ".gitignore"), ".tasks/\nbin/\n")
        git("add", ".gitignore")
        git("commit", "-m", "Initial")

        // Stands in for an agent harness. It fixes `fixable` by committing the
        // file it needs, and claims to have fixed `unfixable` without doing so.
        mkdirSync(join(directory, "bin"))
        const agent = join(directory, "bin", "pi")
        writeFileSync(
            agent,
            [
                "#!/bin/sh",
                "for last; do :; done",
                'case "$last" in',
                '  *"failing check: fixable"*)',
                "    echo yes > fixed && git add fixed && git commit -qm Fix >&2",
                '    printf "Committed the fix.\\nRESOLVED\\n" ;;',
                '  *) printf "Looked at it.\\nRESOLVED\\n" ;;',
                "esac",
            ].join("\n"),
        )
        chmodSync(agent, 0o755)

        const check = (name: string, script: string) => ({
            name,
            command: [process.execPath, "-e", script],
        })
        const fixedInHead =
            "process.exit(Bun.spawnSync(['git','cat-file','-e','HEAD:fixed']).exitCode)"
        const setup = (checks: unknown[]) =>
            writeFileSync(
                join(directory, ".tasks", "tasks.config.json"),
                JSON.stringify({ baseBranch: "main", checks }),
            )
        mkdirSync(join(directory, ".tasks"))

        const run = (script: string) => {
            // Isolate workspace()/database singletons from the rest of the suite.
            const result = Bun.spawnSync(
                [
                    process.execPath,
                    "-e",
                    `
            import { strict as assert } from "node:assert";
            import { startSupervisedChecks, checksSupervision } from ${JSON.stringify(join(import.meta.dir, "checksSupervisor.ts"))};
            const settled = async () => {
                const deadline = Date.now() + 15000;
                for (;;) {
                    const state = checksSupervision("main");
                    if (state.status !== "checking" && state.status !== "fixing") return state;
                    assert.ok(Date.now() < deadline, "supervision did not settle");
                    await Bun.sleep(20);
                }
            };
            startSupervisedChecks({ branch: "main", base: "main", resume: false, previous: null,
                supervisor: { harness: "pi", model: "", permissionMode: "manual", extra: "" } });
            ${script}
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
            return result.stdout.toString()
        }

        setup([
            check("first", "console.log('first passed')"),
            check("fixable", fixedInHead),
        ])
        expect(
            run(`
            const state = await settled();
            assert.equal(state.status, "passed", state.stopReason);
            assert.deepEqual(state.agents.map(a => [a.check, a.command, a.status]),
                [["fixable", "supervise-checks", "succeeded"]]);
            assert.match(state.agents[0].calledFor, /^fixable failed with exit code \\d+\\.$/);
            assert.equal(state.agents[0].verdict, "resolved");
            console.log("fixed and resumed");
        `),
        ).toContain("fixed and resumed")

        setup([check("unfixable", "process.exit(1)")])
        expect(
            run(`
            const state = await settled();
            assert.equal(state.status, "blocked");
            assert.equal(state.agents.length, 2);
            assert.match(state.stopReason, /unfixable still fails after the supervisor was called in 2 times/);
            console.log("stopped at the cap");
        `),
        ).toContain("stopped at the cap")
    } finally {
        rmSync(directory, { recursive: true, force: true })
    }
})
