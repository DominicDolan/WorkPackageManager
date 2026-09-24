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

const script = (path: string, lines: string[]) => {
    writeFileSync(path, ["#!/bin/sh", ...lines].join("\n"))
    chmodSync(path, 0o755)
}

test("a start-to-finish run investigates, works the tasks it filed, and opens the branch's pull request", () => {
    const directory = mkdtempSync(join(tmpdir(), "work-package-pipeline-"))
    try {
        const git = (...args: string[]) => {
            const result = Bun.spawnSync(["git", ...args], { cwd: directory })
            expect(result.exitCode).toBe(0)
        }
        git("init", "-b", "main")
        git("config", "user.name", "Pipeline Test")
        git("config", "user.email", "pipeline@example.invalid")
        writeFileSync(
            join(directory, ".gitignore"),
            ".tasks/\nbin/\norigin.git/\n",
        )
        git("add", ".gitignore")
        git("commit", "-m", "Initial")
        git("init", "--bare", "-b", "main", "origin.git")
        git("remote", "add", "origin", join(directory, "origin.git"))
        git("push", "-q", "origin", "main")

        const bin = join(directory, "bin")
        mkdirSync(bin)
        script(join(bin, "tasks"), [
            `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(import.meta.dir, "..", "cli", "index.ts"))} "$@"`,
        ])
        // Stands in for an agent harness: files one task when investigating,
        // and works it the way `/work-task` does when handed it.
        script(join(bin, "pi"), [
            "for last; do :; done",
            'case "$last" in',
            '  *"Investigation ref (may be empty): `I-1`"*)',
            '    tasks new "Add search" --investigation I-1 --tier fast >&2',
            '    tasks investigation complete I-1 --findings "Search is missing." >&2',
            '    echo "Filed T-1." ;;',
            '  *"Task ref (may be empty): `T-1`"*)',
            "    tasks branch T-1 >&2 && tasks start T-1 >&2",
            "    echo search > search.txt && git add search.txt && git commit -qm 'Add search' >&2",
            "    tasks done T-1 >&2",
            '    echo "Done." ;;',
            '  *) echo "Not expected here." ;;',
            "esac",
        ])
        script(join(bin, "describe"), [
            'printf "TITLE: feat(search): add search\\n\\nAdds search.\\n"',
        ])
        script(join(bin, "gh"), [
            'case "$1 $2" in',
            '  "pr view") exit 1 ;;',
            '  "pr create") echo "https://example.invalid/pull/7" ;;',
            "  *) exit 1 ;;",
            "esac",
        ])
        mkdirSync(join(directory, ".tasks"))
        writeFileSync(
            join(directory, ".tasks", "tasks.config.json"),
            JSON.stringify({
                baseBranch: "main",
                prAgent: [join(bin, "describe")],
                checks: [
                    { name: "ok", command: [process.execPath, "-e", "0"] },
                ],
            }),
        )

        // Isolate workspace()/database singletons from the rest of the suite.
        const result = Bun.spawnSync(
            [
                process.execPath,
                "-e",
                `
            import { strict as assert } from "node:assert";
            import { createWorkPackage, listWorkPackageBranches, findTask, findCombinedBranch } from ${JSON.stringify(join(import.meta.dir, "repo.ts"))};
            import { startWorkRun, workRunDetail, requireWorkRun } from ${JSON.stringify(join(import.meta.dir, "workRuns.ts"))};
            const workPackage = createWorkPackage({
                name: "Search",
                investigations: [{ title: "Why is there no search?", brief: "Find out." }],
                branches: [{ label: "Delivery", branchName: "feature/search", baseBranch: "main" }],
            });
            const [branch] = listWorkPackageBranches(workPackage.ref);
            const agent = { harness: "pi", model: "", permissionMode: "bypassPermissions", extra: "" };
            const started = startWorkRun({
                workPackageRef: workPackage.ref, kind: "pipeline", harness: "pi", model: "",
                mode: "print", permissionMode: "bypassPermissions", extra: "",
                plan: { agent, investigations: ["I-1"], taskRuns: [{ model: "", extra: "" }], branches: [branch.id] },
            });
            assert.equal(started.status, "running");
            const deadline = Date.now() + 30000;
            let run;
            for (;;) {
                run = workRunDetail(requireWorkRun(started.id));
                if (run.status !== "running") break;
                assert.ok(Date.now() < deadline, "the run did not settle: " + JSON.stringify(run.pipeline.steps));
                await Bun.sleep(25);
            }
            assert.equal(run.status, "finished", run.statusDetail + " " + JSON.stringify(run.pipeline.steps));
            assert.deepEqual(run.pipeline.steps.map((step) => [step.kind, step.step ?? null, step.state]), [
                ["investigation", null, "done"],
                ["tasks", null, "done"],
                ["branch", "rebase", "done"],
                ["branch", "describe", "done"],
                ["branch", "checks", "done"],
                ["branch", "pr", "done"],
            ]);
            assert.deepEqual(run.items.map((item) => [item.ref, item.state]), [["T-1", "done"]]);
            assert.equal(findTask("T-1").status, "dev_complete");
            const delivery = findCombinedBranch("feature/search");
            assert.equal(delivery.prTitle, "feat(search): add search");
            assert.equal(delivery.prUrl, "https://example.invalid/pull/7");
            console.log("delivered");
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
                timeout: 40000,
            },
        )
        expect(result.stderr.toString()).toBe("")
        expect(result.exitCode).toBe(0)
        expect(result.stdout.toString()).toContain("delivered")
    } finally {
        rmSync(directory, { recursive: true, force: true })
    }
}, 45000)

test("a stage that stops short blocks the run, and resuming starts that stage again", () => {
    const directory = mkdtempSync(join(tmpdir(), "work-package-pipeline-"))
    try {
        const git = (...args: string[]) => {
            const result = Bun.spawnSync(["git", ...args], { cwd: directory })
            expect(result.exitCode).toBe(0)
        }
        git("init", "-b", "main")
        git("config", "user.name", "Pipeline Test")
        git("config", "user.email", "pipeline@example.invalid")
        writeFileSync(join(directory, ".gitignore"), ".tasks/\nbin/\n")
        git("add", ".gitignore")
        git("commit", "-m", "Initial")

        const bin = join(directory, "bin")
        mkdirSync(bin)
        script(join(bin, "tasks"), [
            `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(import.meta.dir, "..", "cli", "index.ts"))} "$@"`,
        ])
        // Leaves the investigation open the first time, completes it the next.
        script(join(bin, "pi"), [
            "if [ -e bin/tried ]; then",
            '    tasks investigation complete I-1 --findings "Nothing to do." >&2',
            "else",
            "    touch bin/tried",
            "fi",
            'echo "Looked."',
        ])
        mkdirSync(join(directory, ".tasks"))
        writeFileSync(
            join(directory, ".tasks", "tasks.config.json"),
            JSON.stringify({ baseBranch: "main" }),
        )

        const result = Bun.spawnSync(
            [
                process.execPath,
                "-e",
                `
            import { strict as assert } from "node:assert";
            import { createWorkPackage } from ${JSON.stringify(join(import.meta.dir, "repo.ts"))};
            import { startWorkRun, resumeWorkRun, workRunDetail, requireWorkRun } from ${JSON.stringify(join(import.meta.dir, "workRuns.ts"))};
            const workPackage = createWorkPackage({
                name: "Search",
                investigations: [{ title: "Why?", brief: "Find out." }],
            });
            const agent = { harness: "pi", model: "", permissionMode: "manual", extra: "" };
            const started = startWorkRun({
                workPackageRef: workPackage.ref, kind: "pipeline", harness: "pi", model: "",
                mode: "print", permissionMode: "manual", extra: "",
                plan: { agent, investigations: ["I-1"], taskRuns: [], branches: [] },
            });
            const settled = async () => {
                const deadline = Date.now() + 15000;
                for (;;) {
                    const run = workRunDetail(requireWorkRun(started.id));
                    if (run.status !== "running") return run;
                    assert.ok(Date.now() < deadline, "the run did not settle");
                    await Bun.sleep(25);
                }
            };
            const blocked = await settled();
            assert.equal(blocked.status, "blocked");
            assert.match(blocked.statusDetail, /finished without completing I-1/);
            assert.equal(blocked.pipeline.plan.agent.permissionMode, "bypassPermissions");

            resumeWorkRun(started.id);
            const finished = await settled();
            assert.equal(finished.status, "finished", finished.statusDetail);
            assert.equal(finished.pipeline.steps[0].agents.length, 2);
            console.log("resumed");
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
                timeout: 30000,
            },
        )
        expect(result.stderr.toString()).toBe("")
        expect(result.exitCode).toBe(0)
        expect(result.stdout.toString()).toContain("resumed")
    } finally {
        rmSync(directory, { recursive: true, force: true })
    }
}, 35000)
