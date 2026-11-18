import { afterAll, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const directory = mkdtempSync(join(tmpdir(), "transcripts-"))
const tasksDir = join(directory, ".tasks")
const notesDir = join(directory, ".notes")
mkdirSync(tasksDir)
mkdirSync(notesDir)
process.env.TASKS_DIR = tasksDir
process.env.TASKS_DB = join(tasksDir, "tasks.db")
process.env.TASKS_NOTES_DIR = notesDir

const {
    createTask,
    createInvestigation,
    createWorkPackage,
    deleteInvestigation,
} = await import("./repo")
const {
    listTranscripts,
    readTranscript,
    addTranscriptLink,
    removeTranscriptLink,
} = await import("./transcripts")

afterAll(() => rmSync(directory, { recursive: true, force: true }))

test("discovers synced transcripts and attaches them to tasks and investigations", () => {
    const path = "teams-transcript-2026-09-28-planning.json"
    writeFileSync(
        join(notesDir, path),
        JSON.stringify({
            source: "teams",
            fetchedAt: "2026-09-28T14:00:00Z",
            transcript: {
                title: "Planning",
                date: "2026-09-28",
                content: "Alex (1 minute): Plan the work.",
            },
        }),
    )
    writeFileSync(
        join(notesDir, "issue.json"),
        JSON.stringify({ title: "Not a transcript" }),
    )
    const workPackage = createWorkPackage({ name: "Planning work" })
    const task = createTask({
        title: "Build it",
        workPackageRef: workPackage.ref,
    })
    const investigation = createInvestigation({ title: "Explore it" })

    expect(listTranscripts().map((item) => item.path)).toEqual([path])
    expect(readTranscript(path).content).toContain("Plan the work")
    addTranscriptLink(path, "task", task.ref)
    addTranscriptLink(path, "investigation", investigation.ref)
    addTranscriptLink(path, "task", task.ref)
    expect(readTranscript(path).links).toEqual([
        { kind: "investigation", ref: investigation.ref },
        { kind: "task", ref: task.ref },
    ])
    expect(listTranscripts()[0]?.links).toHaveLength(2)
    removeTranscriptLink(path, "task", task.ref)
    expect(readTranscript(path).links).toEqual([
        { kind: "investigation", ref: investigation.ref },
    ])
    deleteInvestigation(investigation.ref)
    expect(readTranscript(path).links).toEqual([])
})

test("rejects paths outside notes and links to missing work", () => {
    expect(() => readTranscript("../outside.json")).toThrow()
    expect(() => readTranscript("issue.json")).toThrow()
    expect(() =>
        addTranscriptLink(
            "teams-transcript-2026-09-28-planning.json",
            "task",
            "T-9999",
        ),
    ).toThrow()
})
