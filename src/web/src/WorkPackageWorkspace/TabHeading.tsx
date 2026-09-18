import {
    action,
    createOptimistic,
    createSignal,
    Show,
    type Element,
} from "solid-js"
import { useError } from "../hooks/useError"

/**
 * The heading of a user-made tab, with its rename and remove actions.
 *
 * The title *is* the tab's name, so renaming it here renames the tab. Removing
 * asks first: what "remove" leaves behind differs by kind, and `confirm` says it.
 */
export function TabHeading(props: {
    title: string
    reference?: string
    description: string
    rename: (title: string) => Promise<unknown>
    remove?: { label: string; confirm: string; run: () => Promise<unknown> }
    changed: () => void
    /** Status badges and the like, drawn at the end of the heading. */
    children?: Element
}) {
    const [editing, setEditing] = createSignal(false)
    const [draft, setDraft] = createSignal("")
    const [busy, setBusy] = createOptimistic("")
    const { capture, clear, Banner } = useError()

    const save = action(function* () {
        if (busy()) return
        const title = draft().trim()
        if (!title || title === props.title) {
            setEditing(false)
            return
        }
        setBusy("rename")
        clear()
        try {
            yield props.rename(title)
            setEditing(false)
            props.changed()
        } catch (caught) {
            capture(caught)
        }
    })
    const remove = action(function* () {
        if (busy() || !props.remove || !confirm(props.remove.confirm)) return
        setBusy("remove")
        clear()
        try {
            yield props.remove.run()
            props.changed()
        } catch (caught) {
            capture(caught)
        }
    })

    return (
        <header class="section mb-4">
            <div class="flex flex-wrap items-end justify-between gap-4">
                <div class="min-w-0">
                    <Show when={props.reference}>
                        <span class="reference">{props.reference}</span>
                    </Show>
                    <Show
                        when={editing()}
                        fallback={
                            <h2 class="m-0 flex items-center gap-2">
                                {props.title}
                            </h2>
                        }>
                        <form
                            class="flex flex-wrap items-center gap-2"
                            onSubmit={(event) => {
                                event.preventDefault()
                                void save()
                            }}>
                            <input
                                aria-label="Tab name"
                                autofocus
                                value={draft()}
                                onInput={(event) =>
                                    setDraft(event.currentTarget.value)
                                }
                                onKeyDown={(event) => {
                                    if (event.key === "Escape")
                                        setEditing(false)
                                }}
                            />
                            <button
                                class="primary"
                                type="submit"
                                aria-busy={
                                    busy() === "rename" ? "true" : "false"
                                }
                                disabled={!!busy() || !draft().trim()}>
                                Save
                            </button>
                            <button
                                class="outlined"
                                type="button"
                                onClick={() => setEditing(false)}>
                                Cancel
                            </button>
                        </form>
                    </Show>
                    <p class="m-[0.3rem_0_0]">{props.description}</p>
                </div>
                <div class="flex flex-wrap items-center gap-2">
                    {props.children}
                    <Show when={!editing()}>
                        <button
                            class="outlined"
                            disabled={!!busy()}
                            onClick={() => {
                                setDraft(props.title)
                                setEditing(true)
                            }}>
                            Rename
                        </button>
                    </Show>
                    <Show when={props.remove}>
                        {(removal) => (
                            <button
                                class="outlined"
                                aria-busy={
                                    busy() === "remove" ? "true" : "false"
                                }
                                disabled={!!busy()}
                                onClick={remove}>
                                {removal().label}
                            </button>
                        )}
                    </Show>
                </div>
            </div>
            <Banner />
        </header>
    )
}
