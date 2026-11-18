/**
 * A repository UI in one file. Everything domain-shaped (which tasks belong to
 * which package, what order they go in, what their status means) comes from
 * the API; this file only renders it and re-renders when the server says the
 * `tasks` channel moved.
 */
import {
    STATUS_LABELS,
    createClient,
    type WorkPackageDetail,
} from "@work-task-manager/client"

// Same origin when served by `tasks web`. A dev server on another port would
// pass `baseUrl: "http://localhost:5199"` and list itself in `ui.origins`.
const api = createClient()
const root = document.getElementById("root")!

async function render(): Promise<void> {
    try {
        const summaries = await api.listWorkPackages()
        const details: WorkPackageDetail[] = await Promise.all(
            summaries.map((one) => api.getWorkPackage(one.ref)),
        )
        root.replaceChildren(
            ...(details.length
                ? details.map(packageSection)
                : [text("p", "No work packages yet.")]),
        )
    } catch (error) {
        const message = text("p", String(error))
        message.className = "error"
        root.replaceChildren(message)
    }
}

function packageSection(workPackage: WorkPackageDetail): HTMLElement {
    const section = document.createElement("section")
    const list = document.createElement("ul")
    for (const task of workPackage.tasks) {
        const item = text("li", `${task.ref} ${task.title}`)
        item.append(text("span", STATUS_LABELS[task.status]))
        list.append(item)
    }
    section.append(text("h2", workPackage.name), list)
    return section
}

function text(tag: string, content: string): HTMLElement {
    const element = document.createElement(tag)
    element.textContent = content
    return element
}

api.subscribe(({ channel }) => {
    if (channel === "tasks") void render()
})
void render()
