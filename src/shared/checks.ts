import type { CheckRun, ChecksReport } from "./types"

export const checkPassed = (run: CheckRun) =>
    run.status === "passed" || run.status === "skipped"

/** Only results for this branch, base and commit can be carried forward. */
export function planChecks(input: {
    names: string[]
    branch: string
    base: string
    headSha: string | null
    check?: string
    from?: string
    resume?: boolean
    previous?: ChecksReport | null
}) {
    const { names, branch, base, headSha, check, from, resume, previous } =
        input
    const valid =
        previous?.branch === branch &&
        previous.base === base &&
        headSha !== null &&
        previous.headSha === headSha
            ? previous.checks.filter((run) => names.includes(run.name))
            : []
    const passed = new Set(valid.filter(checkPassed).map((run) => run.name))
    const selected = check
        ? names.filter((name) => name === check)
        : from
          ? names.slice(names.indexOf(from))
          : resume
            ? names.filter((name) => !passed.has(name))
            : names
    const retained =
        check || from || resume
            ? valid.filter((run) => !selected.includes(run.name))
            : []
    return { selected, retained }
}
