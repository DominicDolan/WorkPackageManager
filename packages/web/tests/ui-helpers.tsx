import { render } from "@solidjs/web"
import { createContext, createSignal, flush, useContext } from "solid-js"
import { Modal } from "../src/components/Modal"
import { useDialog } from "../src/hooks/useDialog"
import { useTabs } from "../src/hooks/useTabs"
import "../src/styles.css"

const Context = createContext("missing")
let open: () => void
let close: () => void
let openLocked: () => void
let openPopover: () => void
let setLabel: (value: string) => void
let mountCount = 0
let closeCount = 0

function Content(props: { close: () => void; label: string }) {
    const context = useContext(Context)
    const mount = ++mountCount
    return (
        <Modal title={props.label} close={props.close}>
            <input id="dialog-input" value={`${context}-${mount}`} />
            <button id="close-dialog" onClick={props.close}>
                Done
            </button>
        </Modal>
    )
}

function Fixture() {
    const tabs = useTabs<"one" | "two">("one")
    const [label, updateLabel] = createSignal("First title")
    setLabel = updateLabel
    const dialog = useDialog(
        ({ closeDialog }) => <Content close={closeDialog} label={label()} />,
        {
            onClose: () => closeCount++,
        },
    )
    open = dialog.openDialog
    close = dialog.closeDialog
    openLocked = useDialog(() => <p>Locked</p>, { closedby: "none" }).openDialog
    openPopover = useDialog(() => <p>Popover</p>, {
        popover: "auto",
    }).openDialog
    return (
        <>
            <button id="opener" onClick={open}>
                Open
            </button>
            <nav role="tablist" class="underlined">
                <button class="custom-tab" ref={tabs.tabProps("one")}>
                    One
                </button>
                <button ref={tabs.tabProps("two")}>Two</button>
            </nav>
            <section {...tabs.windowProps("one")}>First</section>
            <section {...tabs.windowProps("two")}>Second</section>
        </>
    )
}

const results: string[] = []
function check(condition: unknown, message: string) {
    if (!condition) throw new Error(message)
    results.push(`PASS: ${message}`)
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 100))
async function run() {
    const dispose = render(
        () => (
            <Context value="preserved">
                <Fixture />
            </Context>
        ),
        document.getElementById("root")!,
    )
    await tick()
    const tabs = [
        ...document.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
    ]
    const panels = [
        ...document.querySelectorAll<HTMLElement>('[role="tabpanel"]'),
    ]
    check(
        tabs[0].getAttribute("aria-selected") === "true" &&
            !panels[0].hidden &&
            panels[1].hidden,
        "initial tab and panels",
    )
    check(
        tabs[0].classList.contains("custom-tab"),
        "tab ref preserves caller classes",
    )
    check(
        getComputedStyle(tabs[0], "::after").height === "2px" &&
            getComputedStyle(tabs[0], "::after").backgroundColor !==
                getComputedStyle(tabs[1], "::after").backgroundColor,
        "underlined tablist styles the selected button",
    )
    tabs[0].dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    )
    flush()
    check(
        tabs[1].getAttribute("aria-selected") === "true" &&
            tabs[1].tabIndex === 0 &&
            tabs[0].tabIndex === -1,
        "keyboard selection and roving focus",
    )
    check(
        panels[0].hidden &&
            !panels[1].hidden &&
            document.activeElement === tabs[1],
        "panel visibility and focus update",
    )
    tabs[1].dispatchEvent(
        new KeyboardEvent("keydown", { key: "Home", bubbles: true }),
    )
    flush()
    check(
        tabs[0].getAttribute("aria-controls") === panels[0].id &&
            tabs[0].getAttribute("aria-selected") === "true",
        "Home key and panel association",
    )
    const opener = document.getElementById("opener") as HTMLButtonElement
    opener.focus()
    opener.click()
    await tick()
    check(
        document.querySelectorAll("dialog").length === 1 &&
            document.querySelector("dialog")!.matches(":modal"),
        "one native modal, including legacy Modal frame",
    )
    check(
        (document.getElementById("dialog-input") as HTMLInputElement).value ===
            "preserved-1",
        `caller context preserved: ${(document.getElementById("dialog-input") as HTMLInputElement).value}`,
    )
    setLabel("Updated title")
    flush()
    check(
        document.querySelector("dialog")!.getAttribute("aria-label") ===
            "Updated title",
        "reactive accessible title",
    )
    open()
    check(
        document.querySelectorAll("dialog").length === 1,
        "repeated open is idempotent",
    )
    document.getElementById("close-dialog")!.click()
    await tick()
    check(
        !document.querySelector("dialog") &&
            closeCount === 1 &&
            document.activeElement === opener,
        "close button cleanup, callback, and focus restoration",
    )
    open()
    await tick()
    check(
        (document.getElementById("dialog-input") as HTMLInputElement).value ===
            "preserved-2",
        "reopening mounts fresh content",
    )
    document
        .querySelector("dialog")!
        .dispatchEvent(new Event("cancel", { cancelable: true }))
    await tick()
    check(
        !document.querySelector("dialog") && closeCount === 2,
        "Escape cancel closes default dialog",
    )
    open()
    document.querySelector("dialog")!.close("submitted")
    await tick()
    check(
        !document.querySelector("dialog") && closeCount === 3,
        `native close also disposes content: ${closeCount} callbacks, ${document.querySelectorAll("dialog").length} dialogs`,
    )
    openPopover()
    await tick()
    check(
        document.querySelector("dialog")!.matches(":popover-open"),
        "optional native popover",
    )
    document.querySelector("dialog")!.hidePopover()
    await tick()
    check(!document.querySelector("dialog"), "popover dismissal cleanup")
    openLocked()
    document
        .querySelector("dialog")!
        .dispatchEvent(new Event("cancel", { cancelable: true }))
    check(
        document.querySelector("dialog")!.open,
        "closedby none prevents cancel",
    )
    dispose()
    check(
        !document.querySelector("dialog"),
        "owner disposal removes open dialogs",
    )
    open()
    close()
    check(
        !document.querySelector("dialog"),
        "disposed owners cannot reopen dialogs",
    )

    const disposeLegacy = render(
        () => (
            <Modal title="Legacy" close={() => disposeLegacy()}>
                Legacy content
            </Modal>
        ),
        document.getElementById("root")!,
    )
    await tick()
    check(
        document.querySelector("dialog")!.matches(":modal"),
        "standalone legacy caller opens native modal",
    )
    document
        .querySelector("dialog")!
        .dispatchEvent(new Event("cancel", { cancelable: true }))
    await tick()
    check(
        !document.querySelector("dialog"),
        "legacy cancel notifies caller and cleans up",
    )
}

run()
    .then(() => {
        document.getElementById("results")!.textContent =
            results.join("\n") + "\nALL CHECKS PASSED"
    })
    .catch((error) => {
        document.getElementById("results")!.textContent =
            results.join("\n") + `\nFAIL: ${error.stack}`
    })
