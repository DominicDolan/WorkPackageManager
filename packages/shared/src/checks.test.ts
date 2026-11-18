import { expect, test } from "bun:test"
import { planChecks } from "./checks"
import type { CheckRun, ChecksReport } from "./types"

const names = ["typecheck", "lint", "tests", "build"]
const previous: ChecksReport = {
    branch: "feature",
    base: "main",
    headSha: "abc",
    passed: false,
    ranAt: "2026-09-21T12:00:00Z",
    ranOnBranch: "feature",
    checks: [
        { name: "typecheck", status: "passed" },
        { name: "lint", status: "skipped" },
        { name: "tests", status: "failed" },
    ].map(
        (run) =>
            ({
                ...run,
                command: ["test"],
                cwd: ".",
                exitCode: 0,
                output: "",
                durationMs: 10,
            }) as CheckRun,
    ),
}
const input = {
    names,
    branch: "feature",
    base: "main",
    headSha: "abc",
    previous,
}

test("resume retries failures and unrun checks in configured order", () => {
    const plan = planChecks({ ...input, resume: true })
    expect(plan.selected).toEqual(["tests", "build"])
    expect(plan.retained.map((run) => run.name)).toEqual(["typecheck", "lint"])
})

test("single rerun preserves other current results; run all discards them", () => {
    expect(planChecks({ ...input, check: "tests" }).selected).toEqual(["tests"])
    expect(planChecks({ ...input, check: "tests" }).retained).toEqual(
        previous.checks.slice(0, 2),
    )
    expect(planChecks(input)).toEqual({ selected: names, retained: [] })
})

test("resume never retains results from a different or unknown commit, branch or base", () => {
    for (const change of [
        { headSha: "new" },
        { headSha: null },
        { branch: "other" },
        { base: "other" },
    ]) {
        expect(planChecks({ ...input, ...change, resume: true })).toEqual({
            selected: names,
            retained: [],
        })
    }
})

test("resume after manually fixing a failed row only runs missing checks", () => {
    const checks = previous.checks.map((run) => ({
        ...run,
        status: "passed" as const,
    }))
    expect(
        planChecks({
            ...input,
            previous: { ...previous, checks },
            resume: true,
        }).selected,
    ).toEqual(["build"])
})

test("timeouts and configuration errors are retried", () => {
    for (const status of ["timed_out", "error"] as const) {
        const checks = previous.checks.map((run) =>
            run.name === "tests" ? { ...run, status } : run,
        )
        expect(
            planChecks({
                ...input,
                previous: { ...previous, checks },
                resume: true,
            }).selected,
        ).toEqual(["tests", "build"])
    }
})

test("run from a check reruns it and all following checks, retaining only earlier current results", () => {
    const plan = planChecks({ ...input, from: "lint" })
    expect(plan.selected).toEqual(["lint", "tests", "build"])
    expect(plan.retained.map((run) => run.name)).toEqual(["typecheck"])
    expect(
        planChecks({ ...input, from: "lint", headSha: "new" }).retained,
    ).toEqual([])
    expect(planChecks({ ...input, from: "build" }).selected).toEqual(["build"])
})
