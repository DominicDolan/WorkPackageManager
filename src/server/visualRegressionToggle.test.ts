import { afterAll, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const directory = mkdtempSync(join(tmpdir(), "task-vr-toggle-"))
const tasksDir = join(directory, ".tasks")
mkdirSync(tasksDir)
process.env.TASKS_DIR = tasksDir
process.env.TASKS_DB = join(tasksDir, "tasks.db")
process.env.TASKS_NOTES_DIR = join(directory, ".notes")
process.env.AIO_VR_DIR = join(directory, ".aio-vr")
afterAll(() => rmSync(directory, { recursive: true, force: true }))

const { createTask, createWorkPackage, updateTask, requireTask } =
    await import("./repo")
const { buildPrompt } = await import("./agents")

const workPackage = createWorkPackage({ name: "Visual regression toggle" })

// Words that only the visual-regression procedure uses. None may reach the
// agent when the task has checkpoints switched off.
const VISUAL_WORDS = /visual|checkpoint|scenario|aio-vr|5175|--retro|--settle/i

test("a task is on by default", () => {
    const task = createTask({
        title: "Default task",
        workPackageRef: workPackage.ref,
    })
    expect(task.useVisualRegression).toBe(true)
})

test("a task can be filed with visual regression off", () => {
    const task = createTask({
        title: "No visuals",
        workPackageRef: workPackage.ref,
        useVisualRegression: false,
    })
    expect(task.useVisualRegression).toBe(false)
    expect(requireTask(task.ref).useVisualRegression).toBe(false)
})

test("updating the flag stores it and turning it back on restores it", () => {
    const task = createTask({
        title: "Toggled",
        workPackageRef: workPackage.ref,
    })
    expect(
        updateTask(task.ref, { useVisualRegression: false })
            .useVisualRegression,
    ).toBe(false)
    expect(
        updateTask(task.ref, { useVisualRegression: true }).useVisualRegression,
    ).toBe(true)
})

test("the agent is not told about visual regression when it is off", () => {
    const task = createTask({
        title: "Agent without visuals",
        workPackageRef: workPackage.ref,
        useVisualRegression: false,
    })
    const prompt = buildPrompt("work-task", task.ref, "")
    expect(prompt).not.toMatch(VISUAL_WORDS)
    expect(prompt).not.toContain("<!-- visual-regression")
    // The rest of the procedure is still there.
    expect(prompt).toContain("tasks start")
    expect(prompt).toContain("tasks done")
    expect(prompt).toContain("## 9. Mark it dev complete")
})

test("the agent keeps the visual-regression procedure when it is on", () => {
    const task = createTask({
        title: "Agent with visuals",
        workPackageRef: workPackage.ref,
    })
    const prompt = buildPrompt("work-task", task.ref, "")
    expect(prompt).toContain("tasks checkpoint before")
    expect(prompt).toContain("tasks checkpoint after")
    expect(prompt).not.toContain("<!-- visual-regression")
    expect(prompt).not.toContain("<!-- /visual-regression")
})

test("an unknown ref keeps the full procedure", () => {
    const prompt = buildPrompt("work-task", "", "")
    expect(prompt).toContain("tasks checkpoint before")
    expect(prompt).not.toContain("<!-- visual-regression")
})
