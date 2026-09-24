import type { Note } from "@shared/types"
import { action, createOptimistic, Show, createSignal } from "solid-js"
import { api, noteAssetUrl } from "../api"
import {
    AddToWorkPackageButtons,
    type WorkItemKind,
} from "../components/AddToWorkPackage"
import { BackIcon } from "../components/icons"
import { renderMarkdown } from "../markdown"
import { useError } from "../hooks/useError"

export function NoteEditor(props: {
    note: Note
    mode: "write" | "preview"
    setMode: (mode: "write" | "preview") => void
    saved: () => Promise<unknown>
    close: () => void
    /** Turn the saved note into a task or an investigation. */
    add: (kind: WorkItemKind) => void
}) {
    const [title, setTitle] = createSignal(() => props.note.title)
    const [tags, setTags] = createSignal(() => props.note.tags.join(", "))
    const [body, setBody] = createSignal(() => props.note.body)
    const [busy, setBusy] = createOptimistic("")
    const { capture, clear, Banner } = useError()
    let editor: HTMLTextAreaElement | undefined
    const noteInput = () => ({
        title: title().trim(),
        body: body(),
        tags: tags()
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean),
    })
    const preview = () =>
        renderMarkdown(body(), {
            resolveLink: (href) => noteAssetUrl(props.note.path, href),
        })
    const applySavedNote = (note: Note) => {
        setTitle(note.title)
        setTags(note.tags.join(", "))
        setBody(note.body)
    }
    const save = action(async function* () {
        if (busy()) return

        setBusy("save")
        clear()
        try {
            const note = await api.updateNote(props.note.path, noteInput())
            yield
            applySavedNote(note)
            yield props.saved()
        } catch (caught) {
            yield
            capture(caught)
        }
    })
    const remove = action(function* () {
        if (busy()) return

        if (!confirm(`Delete ${title()}?`)) return
        setBusy("remove")
        try {
            yield api.deleteNote(props.note.path)

            props.close()
            yield props.saved()
        } catch (caught) {
            capture(caught)
        }
    })

    const insertAtCursor = (markdown: string): string => {
        const start = editor?.selectionStart ?? body().length
        const end = editor?.selectionEnd ?? start
        const before = body().slice(0, start)
        const after = body().slice(end)
        const next = `${before}${before && !before.endsWith("\n") ? "\n\n" : ""}${markdown}\n${after}`
        setBody(next)
        const caret = next.length - after.length
        requestAnimationFrame(() => {
            editor?.focus()
            editor?.setSelectionRange(caret, caret)
        })
        return next
    }

    const pasteImages = action(async function* (event: ClipboardEvent) {
        if (busy()) return

        const images = [...(event.clipboardData?.files ?? [])].filter((file) =>
            file.type.startsWith("image/"),
        )
        if (!images.length) return
        event.preventDefault()
        setBusy("pasteImages")
        clear()
        try {
            // Attachments belong to a saved note. Save the current draft first so the
            // final update cannot replace text typed before the paste.
            yield api.updateNote(props.note.path, noteInput())

            const uploaded = await api.uploadAttachments(
                props.note.path,
                images,
            )
            yield
            const nextBody = insertAtCursor(
                uploaded.added.map((item) => item.markdown).join("\n"),
            )
            const note = await api.updateNote(props.note.path, {
                body: nextBody,
            })
            yield
            applySavedNote(note)
            yield props.saved()
        } catch (caught) {
            yield
            capture(caught)
        }
    })

    return (
        <article class="document max-w-[980px] p-[clamp(1.25rem,_3vw,_3rem)]">
            <div class="flex flex-wrap items-center justify-between gap-[0.75rem] mb-[1.4rem]">
                <button
                    class="back inline-flex items-center gap-[0.35rem]"
                    onClick={props.close}>
                    <BackIcon />
                    All notes & issues
                </button>
                <AddToWorkPackageButtons add={props.add} />
            </div>
            <header class="flex items-start justify-between gap-[1rem] pb-[1.25rem] max-[560px]:block">
                <div>
                    <p class="reference">{props.note.path}</p>
                    <h2 class="max-w-[25ch] m-[0.4rem_0_0]">{title()}</h2>
                </div>
                <div class="flex flex-wrap gap-2">
                    <div
                        class="segmented flex"
                        role="group"
                        aria-label="Note view">
                        <button
                            class="min-h-[2.5rem] p-[0.5rem_0.8rem]"
                            aria-pressed={
                                props.mode === "write" ? "true" : "false"
                            }
                            onClick={() => props.setMode("write")}>
                            Write
                        </button>
                        <button
                            class="min-h-[2.5rem] p-[0.5rem_0.8rem]"
                            aria-pressed={
                                props.mode === "preview" ? "true" : "false"
                            }
                            onClick={() => props.setMode("preview")}>
                            Preview
                        </button>
                    </div>
                    <button
                        aria-busy={busy() === "remove" ? "true" : "false"}
                        class="outlined"
                        disabled={!!busy()}
                        onClick={remove}>
                        Delete
                    </button>
                    <button
                        aria-busy={busy() === "save" ? "true" : "false"}
                        class="primary"
                        disabled={!title().trim() || !!busy()}
                        onClick={save}>
                        Save changes
                    </button>
                </div>
            </header>
            <Banner />
            <Show
                when={props.mode === "write"}
                fallback={
                    <article
                        class="prose min-h-[26rem] mt-[1.5rem] p-[clamp(1.25rem,_3vw,_2.25rem)]"
                        innerHTML={preview()}
                    />
                }>
                <div class="editor-fields grid gap-[1.1rem] mt-[1.5rem]">
                    <label class="field">
                        <span>Title</span>
                        <input
                            value={title()}
                            onInput={(event) =>
                                setTitle(event.currentTarget.value)
                            }
                        />
                    </label>
                    <label class="field">
                        <span>Tags</span>
                        <input
                            value={tags()}
                            onInput={(event) =>
                                setTags(event.currentTarget.value)
                            }
                            placeholder="research, decision"
                        />
                    </label>
                    <label class="field">
                        <span>
                            Markdown — paste an image to attach and insert it
                            here
                        </span>
                        <textarea
                            aria-busy={
                                busy() === "pasteImages" ? "true" : "false"
                            }
                            ref={editor}
                            class="code !min-h-[26rem]"
                            value={body()}
                            onInput={(event) =>
                                setBody(event.currentTarget.value)
                            }
                            onPaste={pasteImages}
                        />
                    </label>
                </div>
            </Show>
        </article>
    )
}
