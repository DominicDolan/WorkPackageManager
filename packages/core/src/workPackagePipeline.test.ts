import { expect, test } from "bun:test"
import {
    chmodSync,
    mkdirSync,
    mkdtempSync,
    rmSync,
    readFileSync,
    writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const script = (path: string, lines: string[]) => {
    writeFileSync(path, ["#!/bin/sh", ...lines].join("\n"))
    chmodSync(path, 0o755)
}

test("a start-to-finish run leaves excluded tasks alone, works investigation tasks, and opens a pull request", () => {
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
            `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(import.meta.dir, "..", "..", "cli", "src", "index.ts"))} "$@"`,
        ])
        // Stands in for an agent harness: files one task when investigating,
        // and works it the way `/work-task` does when handed it.
        script(join(bin, "pi"), [
            "for last; do :; done",
            'case "$last" in',
            '  *"Investigation ref (may be empty): \\`I-1\\`"*)',
            '    tasks new "Add search" --investigation I-1 --tier fast >&2',
            '    tasks investigation complete I-1 --findings "Search is missing." >&2',
            '    echo "Filed T-2." ;;',
            '  *"Task ref (may be empty): \\`T-2\\`"*)',
            "    tasks branch T-2 >&2 && tasks start T-2 >&2",
            "    echo search > search.txt && git add search.txt && git commit -qm 'Add search' >&2",
            "    tasks done T-2 >&2",
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
            import { createWorkPackage, createTask, listWorkPackageBranches, findTask, findCombinedBranch } from ${JSON.stringify(join(import.meta.dir, "repo.ts"))};
            import { startWorkRun, workRunDetail, requireWorkRun } from ${JSON.stringify(join(import.meta.dir, "workRuns.ts"))};
            const workPackage = createWorkPackage({
                name: "Search",
                investigations: [{ title: "Why is there no search?", brief: "Find out." }],
                branches: [{ label: "Delivery", branchName: "feature/search", baseBranch: "main" }],
            });
            const excluded = createTask({ title: "Leave this alone", workPackageRef: workPackage.ref, branchId: null });
            const [branch] = listWorkPackageBranches(workPackage.ref);
            const agent = { harness: "pi", model: "", permissionMode: "bypassPermissions", extra: "" };
            const started = startWorkRun({
                workPackageRef: workPackage.ref, kind: "pipeline", harness: "pi", model: "",
                mode: "print", permissionMode: "bypassPermissions", extra: "",
                plan: { agent, investigations: ["I-1"], taskRun: { model: "", extra: "", excluded: [excluded.ref.toLowerCase(), excluded.ref] }, branches: [branch.id] },
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
            assert.deepEqual(run.items.map((item) => [item.ref, item.state]), [["T-2", "done"]]);
            assert.equal(findTask("T-2").status, "dev_complete");
            assert.deepEqual(run.pipeline.plan.taskRun.excluded, [excluded.ref]);
            assert.equal(findTask(excluded.ref).status, "backlog");
            assert.deepEqual(findTask(excluded.ref).targetBranches, []);
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

test("a blocked investigation resumes with a different harness and settings", () => {
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
            `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(import.meta.dir, "..", "..", "cli", "src", "index.ts"))} "$@"`,
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
        script(join(bin, "claude"), [
            'tasks investigation complete I-1 --findings "Nothing to do." >&2',
            'echo "Looked with the new agent."',
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
                plan: { agent, investigations: ["I-1"], taskRun: { model: "", extra: "" }, branches: [] },
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

            assert.throws(() => resumeWorkRun(started.id, {
                agent: { ...agent, permissionMode: "plan" },
            }), /Plan only/);
            assert.equal(workRunDetail(requireWorkRun(started.id)).status, "blocked");
            resumeWorkRun(started.id, {
                agent: { harness: "claude", model: "new-supervisor-model", permissionMode: "manual", extra: "Use the new instructions." },
                taskRun: { model: "new-task-model", extra: "New task instructions." },
            });
            const finished = await settled();
            assert.equal(finished.status, "finished", finished.statusDetail);
            assert.equal(finished.pipeline.steps[0].agents.length, 2);
            assert.equal(finished.harness, "claude");
            assert.equal(finished.model, "new-supervisor-model");
            assert.equal(finished.extra, "Use the new instructions.");
            assert.equal(finished.permissionMode, "bypassPermissions");
            const { findAgentRun } = await import(${JSON.stringify(join(import.meta.dir, "agents.ts"))});
            const resumed = findAgentRun(finished.pipeline.steps[0].agents[1].id);
            assert.equal(resumed.harness, "claude");
            assert.equal(resumed.model, "new-supervisor-model");
            assert.equal(finished.pipeline.plan.taskRun.model, "new-task-model");
            assert.equal(finished.pipeline.plan.taskRun.extra, "New task instructions.");
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

test("a background stage that fails blocks the run instead of being tried again", () => {
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
        git("switch", "-c", "feature/ready")
        writeFileSync(join(directory, "ready.txt"), "ready\n")
        git("add", "ready.txt")
        git("commit", "-m", "Ready")
        git("switch", "main")

        const bin = join(directory, "bin")
        mkdirSync(bin)
        // Counts its calls, so a stage retried in a loop shows up.
        script(join(bin, "describe"), [
            "echo x >> bin/describe-calls",
            'echo "no model available" >&2',
            "exit 3",
        ])
        mkdirSync(join(directory, ".tasks"))
        writeFileSync(
            join(directory, ".tasks", "tasks.config.json"),
            JSON.stringify({
                baseBranch: "main",
                prAgent: [join(bin, "describe")],
            }),
        )

        const result = Bun.spawnSync(
            [
                process.execPath,
                "-e",
                `
            import { strict as assert } from "node:assert";
            import { readFileSync } from "node:fs";
            import { createWorkPackage, listWorkPackageBranches } from ${JSON.stringify(join(import.meta.dir, "repo.ts"))};
            import { startWorkRun, workRunDetail, requireWorkRun } from ${JSON.stringify(join(import.meta.dir, "workRuns.ts"))};
            const workPackage = createWorkPackage({
                name: "Ready",
                branches: [{ label: "Ready", branchName: "feature/ready", existing: true }],
            });
            const [branch] = listWorkPackageBranches(workPackage.ref);
            const agent = { harness: "pi", model: "", permissionMode: "bypassPermissions", extra: "" };
            const started = startWorkRun({
                workPackageRef: workPackage.ref, kind: "pipeline", harness: "pi", model: "",
                mode: "print", permissionMode: "bypassPermissions", extra: "",
                plan: { agent, investigations: [], taskRun: null, branches: [branch.id] },
            });
            const deadline = Date.now() + 15000;
            let run;
            for (;;) {
                run = workRunDetail(requireWorkRun(started.id));
                if (run.status !== "running") break;
                assert.ok(Date.now() < deadline, "the run did not settle");
                await Bun.sleep(25);
            }
            assert.equal(run.status, "blocked");
            assert.match(run.statusDetail, /no model available/);
            // Branch steps only: no investigation, and the tasks left alone.
            assert.deepEqual(run.pipeline.steps.map((step) => step.kind === "branch" ? step.step : step.kind),
                ["rebase", "describe", "checks", "pr"]);
            assert.deepEqual(run.pipeline.steps.map((step) => step.state),
                ["done", "blocked", "waiting", "waiting"]);
            await Bun.sleep(200);
            assert.equal(readFileSync("bin/describe-calls", "utf8"), "x\\n");
            console.log("blocked once");
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
                timeout: 20000,
            },
        )
        expect(result.stderr.toString()).toBe("")
        expect(result.exitCode).toBe(0)
        expect(result.stdout.toString()).toContain("blocked once")
    } finally {
        rmSync(directory, { recursive: true, force: true })
    }
}, 25000)

test("task selection validates refs, skips an empty selection, and respects dependencies", () => {
    const directory = mkdtempSync(join(tmpdir(), "work-package-pipeline-"))
    try {
        mkdirSync(join(directory, ".tasks"))
        writeFileSync(join(directory, ".tasks", "tasks.config.json"), "{}")
        const result = Bun.spawnSync(
            [
                process.execPath,
                "-e",
                `
            import { strict as assert } from "node:assert";
            import { createWorkPackage, createTask, findTask } from ${JSON.stringify(join(import.meta.dir, "repo.ts"))};
            import { preparePipeline } from ${JSON.stringify(join(import.meta.dir, "workPackagePipeline.ts"))};
            import { startWorkRun, workRunDetail, requireWorkRun } from ${JSON.stringify(join(import.meta.dir, "workRuns.ts"))};
            const workPackage = createWorkPackage({ name: "Selection" });
            const dependency = createTask({ title: "Dependency", workPackageRef: workPackage.ref, useGitWorkflow: false });
            const selected = createTask({ title: "Selected", workPackageRef: workPackage.ref, useGitWorkflow: false, dependsOn: [dependency.ref] });
            const other = createWorkPackage({ name: "Other" });
            const foreign = createTask({ title: "Foreign", workPackageRef: other.ref, useGitWorkflow: false });
            const agent = { harness: "pi", model: "", permissionMode: "bypassPermissions", extra: "" };
            const plan = (excluded) => ({ agent, investigations: [], taskRun: { model: "", extra: "", excluded }, branches: [] });
            assert.throws(() => preparePipeline(workPackage.ref, plan([foreign.ref])), /not an unfinished task/);
            assert.throws(() => preparePipeline(workPackage.ref, plan(["T-999"])), /not an unfinished task/);
            const start = (excluded) => startWorkRun({
                workPackageRef: workPackage.ref, kind: "pipeline", ...agent, mode: "print", plan: plan(excluded),
            });
            const settled = async (id) => {
                const deadline = Date.now() + 5000;
                for (;;) {
                    const run = workRunDetail(requireWorkRun(id));
                    if (run.status !== "running") return run;
                    assert.ok(Date.now() < deadline, "the run did not settle");
                    await Bun.sleep(10);
                }
            };
            const empty = await settled(start([dependency.ref, selected.ref]).id);
            assert.equal(empty.status, "finished");
            assert.deepEqual(empty.items, []);
            assert.equal(empty.pipeline.steps[0].workPackageRunId, null);
            const blocked = await settled(start([dependency.ref]).id);
            assert.equal(blocked.status, "blocked");
            assert.match(blocked.statusDetail, /waiting on unfinished work this run will not do/);
            assert.equal(findTask(dependency.ref).status, "backlog");
            assert.equal(findTask(selected.ref).status, "backlog");
            console.log("selection checked");
            process.exit(0);
        `,
            ],
            {
                cwd: directory,
                env: {
                    ...process.env,
                    TASKS_DIR: join(directory, ".tasks"),
                    TASKS_DB: join(directory, ".tasks", "tasks.db"),
                },
                timeout: 10000,
            },
        )
        expect(result.stderr.toString()).toBe("")
        expect(result.exitCode).toBe(0)
        expect(result.stdout.toString()).toContain("selection checked")
    } finally {
        rmSync(directory, { recursive: true, force: true })
    }
}, 15000)

test("a resumed task stage changes settings and preserves its fixed selection", () => {
    const directory = mkdtempSync(join(tmpdir(), "work-package-pipeline-"))
    try {
        const bin = join(directory, "bin")
        mkdirSync(bin)
        script(join(bin, "tasks"), [
            `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(import.meta.dir, "..", "..", "cli", "src", "index.ts"))} "$@"`,
        ])
        script(join(bin, "pi"), [
            "for last; do :; done",
            'case "$last" in',
            '  *"Task ref (may be empty): \\`T-1\\`"*)',
            "    tasks start T-1 >&2 && tasks done T-1 >&2 ;;",
            '  *) echo "Needs attention." ;;',
            "esac",
        ])
        script(join(bin, "claude"), [
            "tasks start T-3 >&2 && tasks done T-3 >&2",
            'echo "Finished with the new agent."',
        ])
        mkdirSync(join(directory, ".tasks"))
        writeFileSync(join(directory, ".tasks", "tasks.config.json"), "{}")
        const result = Bun.spawnSync(
            [
                process.execPath,
                "-e",
                `
            import { strict as assert } from "node:assert";
            import { createWorkPackage, createTask, findTask, requireWorkPackageRun } from ${JSON.stringify(join(import.meta.dir, "repo.ts"))};
            import { startWorkRun, resumeWorkRun, workRunDetail, requireWorkRun } from ${JSON.stringify(join(import.meta.dir, "workRuns.ts"))};
            const workPackage = createWorkPackage({ name: "Resume tasks" });
            const first = createTask({ title: "First", workPackageRef: workPackage.ref, useGitWorkflow: false });
            const excluded = createTask({ title: "Left out", workPackageRef: workPackage.ref, useGitWorkflow: false });
            const next = createTask({ title: "Next", workPackageRef: workPackage.ref, useGitWorkflow: false, dependsOn: [first.ref] });
            const agent = { harness: "pi", model: "old-model", permissionMode: "bypassPermissions", extra: "Old instructions." };
            const started = startWorkRun({
                workPackageRef: workPackage.ref, kind: "pipeline", ...agent, mode: "print",
                plan: { agent, investigations: [], taskRun: { model: "old-task-model", extra: "Old task instructions.", excluded: [excluded.ref], selected: [first.ref, next.ref] }, branches: [] },
            });
            const settled = async () => {
                const deadline = Date.now() + 10000;
                for (;;) {
                    const run = workRunDetail(requireWorkRun(started.id));
                    if (run.status !== "running") return run;
                    assert.ok(Date.now() < deadline, "the run did not settle");
                    await Bun.sleep(10);
                }
            };
            const blocked = await settled();
            assert.equal(blocked.status, "blocked", blocked.statusDetail);
            const loopId = blocked.pipeline.steps[0].workPackageRunId;
            assert.deepEqual(requireWorkPackageRun(loopId).worked, [first.ref]);
            const added = createTask({ title: "Added before resume", workPackageRef: workPackage.ref, useGitWorkflow: false });
            resumeWorkRun(started.id, {
                agent: { harness: "claude", model: "new-supervisor-model", permissionMode: "auto", extra: "New supervisor instructions." },
                taskRun: { model: "new-task-model", extra: "New task instructions." },
            });
            const finished = await settled();
            assert.equal(finished.status, "finished", finished.statusDetail);
            assert.equal(finished.pipeline.steps[0].workPackageRunId, loopId);
            const loop = requireWorkPackageRun(loopId);
            assert.deepEqual(loop.worked, [first.ref, next.ref]);
            assert.deepEqual(loop.excluded, [excluded.ref]);
            assert.deepEqual(loop.selected, [first.ref, next.ref]);
            assert.equal(findTask(added.ref).status, "backlog");
            assert.equal(loop.harness, "claude");
            assert.equal(loop.model, "new-task-model");
            assert.equal(loop.extra, "New task instructions.");
            assert.equal(loop.permissionMode, "auto");
            assert.equal(loop.supervisor.harness, "claude");
            assert.equal(loop.supervisor.model, "new-supervisor-model");
            assert.equal(loop.supervisor.extra, "New supervisor instructions.");
            assert.equal(findTask(excluded.ref).status, "backlog");
            assert.deepEqual(finished.items.map((item) => item.ref), [first.ref, next.ref]);
            assert.equal(finished.items[0].agents.length, 1);
            const { findAgentRun } = await import(${JSON.stringify(join(import.meta.dir, "agents.ts"))});
            const resumed = findAgentRun(finished.items[1].agents.at(-1).id);
            assert.equal(resumed.harness, "claude");
            assert.equal(resumed.model, "new-task-model");
            assert.ok(resumed.prompt.includes("New task instructions."));
            console.log("task settings resumed");
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
        expect(result.stdout.toString()).toContain("task settings resumed")
    } finally {
        rmSync(directory, { recursive: true, force: true })
    }
}, 20000)

for (const mode of ["all", "selected"] as const) {
    test(`${mode} task mode handles tasks added while the loop is working`, () => {
        const directory = mkdtempSync(join(tmpdir(), "pipeline-selection-"))
        try {
            const bin = join(directory, "bin")
            mkdirSync(bin)
            script(join(bin, "tasks"), [
                `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(import.meta.dir, "..", "..", "cli", "src", "index.ts"))} "$@"`,
            ])
            script(join(bin, "pi"), [
                "exec 2>>bin/agent.log",
                "for last; do :; done",
                'case "$last" in',
                '  *"Task ref (may be empty): \\`T-1\\`"*)',
                '    tasks new "Added during the run" --work-package WP-1 --no-git >&2',
                "    tasks start T-1 >&2 && tasks done T-1 >&2 ;;",
                '  *"Task ref (may be empty): \\`T-2\\`"*)',
                "    tasks start T-2 >&2 && tasks done T-2 >&2 ;;",
                '  *) echo "Unexpected task" >&2; exit 1 ;;',
                "esac",
            ])
            mkdirSync(join(directory, ".tasks"))
            writeFileSync(join(directory, ".tasks", "tasks.config.json"), "{}")
            const result = Bun.spawnSync(
                [
                    process.execPath,
                    "-e",
                    `
                import { strict as assert } from "node:assert";
                import { createWorkPackage, createTask, findTask, requireWorkPackageRun } from ${JSON.stringify(join(import.meta.dir, "repo.ts"))};
                import { startWorkRun, workRunDetail, requireWorkRun } from ${JSON.stringify(join(import.meta.dir, "workRuns.ts"))};
                const wp = createWorkPackage({ name: "Selection" });
                const first = createTask({ title: "First", workPackageRef: wp.ref, useGitWorkflow: false });
                const selected = ${JSON.stringify(mode)} === "selected";
                const agent = { harness: "pi", model: "", permissionMode: "bypassPermissions", extra: "" };
                const started = startWorkRun({
                    workPackageRef: wp.ref, kind: "pipeline", ...agent, mode: "print",
                    plan: { agent, investigations: [], branches: [], taskRun: { model: "", extra: "", ...(selected ? { selected: [first.ref.toLowerCase(), first.ref] } : {}) } },
                });
                const deadline = Date.now() + 10000;
                let run;
                for (;;) {
                    run = workRunDetail(requireWorkRun(started.id));
                    if (run.status !== "running") break;
                    assert.ok(Date.now() < deadline, "run did not settle");
                    await Bun.sleep(10);
                }
                assert.equal(run.status, "finished", run.statusDetail);
                assert.equal(findTask("T-1").status, "dev_complete");
                assert.equal(findTask("T-2").status, selected ? "backlog" : "dev_complete");
                assert.deepEqual(run.items.map((item) => item.ref), selected ? ["T-1"] : ["T-1", "T-2"]);
                const loop = requireWorkPackageRun(run.pipeline.steps[0].workPackageRunId);
                assert.deepEqual(loop.selected, selected ? ["T-1"] : null);
                assert.deepEqual(loop.worked, selected ? ["T-1"] : ["T-1", "T-2"]);
                assert.equal(run.pipeline.steps[0].title, selected ? "Selected tasks" : "All open tasks");
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
            expect(
                result.stderr.toString() +
                    (result.exitCode
                        ? readFileSync(join(bin, "agent.log"), "utf8")
                        : ""),
            ).toBe("")
            expect(result.exitCode).toBe(0)
        } finally {
            rmSync(directory, { recursive: true, force: true })
        }
    }, 20000)
}
