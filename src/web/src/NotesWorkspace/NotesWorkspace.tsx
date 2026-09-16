import {
  For,
  Loading,
  Show,
  createEffect,
  createMemo,
  createSignal,
  refresh,
} from "solid-js"
import type { Note, NotesWorkspaceInfo } from "@shared/types"
import { api, noteAssetUrl } from "../api"
import { renderMarkdown } from "../markdown"
import { PageSkeleton } from "../components/PageSkeleton"
import { ProductRail } from "../components/ProductRail"
import { PlusIcon } from "../components/icons"
import type { MainView } from "../types/navigation"
import layoutStyles from "../components/LibraryLayout.module.css"
import styles from "./NotesWorkspace.module.css"

export function NotesWorkspace(props: {
  select: (view: MainView) => void
  initialPath?: string
  revision: number
}) {
  const [query, setQuery] = createSignal("")
  const [folder, setFolder] = createSignal("")
  const [tag, setTag] = createSignal("")
  const [selectedPath, setSelectedPath] = createSignal(props.initialPath ?? "")
  const [noteMode, setNoteMode] = createSignal<"write" | "preview">("preview")
  const [creating, setCreating] = createSignal(false)
  const [newTitle, setNewTitle] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal("")
  const listing = createMemo(() =>
    api.listNotes({
      q: query() || undefined,
      folder: folder() || undefined,
      tag: tag() || undefined,
    }),
  )
  const selected = createMemo(async (): Promise<Note | null> =>
    selectedPath() ? api.getNote(selectedPath()) : null,
  )
  createEffect(
    () => props.revision,
    () => {
      refresh(listing)
      refresh(selected)
    },
  )

  const choose = (path: string) => {
    setSelectedPath(path)
    setNoteMode("preview")
    refresh(selected)
  }
  const create = async () => {
    if (!newTitle().trim()) return
    setBusy(true)
    setError("")
    try {
      const note = await api.createNote({
        title: newTitle().trim(),
        folder: folder() || undefined,
      })
      setCreating(false)
      setNewTitle("")
      refresh(listing)
      choose(note.path)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }
  const initialise = async () => {
    setBusy(true)
    setError("")
    try {
      await api.initNotes()
      refresh(listing)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }
  const sync = async () => {
    setBusy(true)
    setError("")
    try {
      await api.pullNotes()
      refresh(listing)
      refresh(selected)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }
  const push = async () => {
    setBusy(true)
    setError("")
    try {
      await api.syncNotes(true)
      refresh(listing)
      refresh(selected)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <main
      class={`${layoutStyles.scope} ${styles.scope} app-shell min-h-screen text-slate-950`}
    >
      <ProductRail active="notes" select={props.select} />
      <Loading fallback={<PageSkeleton />}>
        <Show when={listing()} keyed>
          {(data) => (
            <section class="library-surface">
              <header class="library-header">
                <div>
                  <p class="eyebrow">Reference workspace</p>
                  <h1>Notes</h1>
                  <p>
                    Keep research, decisions and evidence in a versioned folder
                    beside the work.
                  </p>
                </div>
                <div class="library-header-actions">
                  <Show when={data.workspace.exists && data.workspace.git.repo}>
                    <button class="button" disabled={busy()} onClick={sync}>
                      {busy() ? "Syncing…" : "Sync"}
                    </button>
                    <button
                      class="button"
                      disabled={busy() || !data.workspace.git.upstream}
                      title={
                        data.workspace.git.upstream ??
                        "No upstream configured for this repository."
                      }
                      onClick={push}
                    >
                      {busy() ? "Pushing…" : "Push"}
                    </button>
                  </Show>
                  <button
                    class="button-primary"
                    disabled={!data.workspace.exists || busy()}
                    onClick={() => setCreating(true)}
                  >
                    <PlusIcon />
                    New note
                  </button>
                </div>
              </header>
              <Show when={error()}>
                <p class="banner mb-5">{error()}</p>
              </Show>
              <div class="library-layout">
                <aside class="library-list">
                  <label class="library-search">
                    <span>Find a note</span>
                    <input
                      value={query()}
                      onInput={(event) => setQuery(event.currentTarget.value)}
                      placeholder="Search notes"
                      type="search"
                    />
                  </label>
                  <Show when={data.folders.length > 0 || data.tags.length > 0}>
                    <div class="library-filters">
                      <Show when={data.folders.length > 0}>
                        <select
                          value={folder()}
                          onChange={(event) =>
                            setFolder(event.currentTarget.value)
                          }
                        >
                          <option value="">All folders</option>
                          <For each={data.folders}>
                            {(item) => <option value={item}>{item}</option>}
                          </For>
                        </select>
                      </Show>
                      <Show when={data.tags.length > 0}>
                        <select
                          value={tag()}
                          onChange={(event) =>
                            setTag(event.currentTarget.value)
                          }
                        >
                          <option value="">All tags</option>
                          <For each={data.tags}>
                            {(item) => <option value={item}>#{item}</option>}
                          </For>
                        </select>
                      </Show>
                    </div>
                  </Show>
                  <div class="note-list">
                    <For
                      each={data.notes}
                      fallback={
                        <p class="empty-copy p-4">
                          {data.workspace.exists
                            ? "No notes match these filters."
                            : "The notes folder has not been created yet."}
                        </p>
                      }
                    >
                      {(item) => (
                        <button
                          class={`note-list-item ${selectedPath() === item.path ? "note-list-active" : ""}`}
                          onClick={() => choose(item.path)}
                        >
                          <span>
                            {item.folder ? `${item.folder}/` : "Note"}
                          </span>
                          <strong>{item.title}</strong>
                          <p>{item.excerpt || "No preview yet."}</p>
                          <small>
                            {item.tags.map((value) => `#${value}`).join(" ")}
                          </small>
                        </button>
                      )}
                    </For>
                  </div>
                  <NotesStatus
                    workspace={data.workspace}
                    busy={busy()}
                    initialise={initialise}
                  />
                </aside>
                <section class="note-detail-pane">
                  <Show
                    when={creating()}
                    fallback={
                      <Loading fallback={<PageSkeleton compact />}>
                        <Show
                          when={selected()}
                          keyed
                          fallback={
                            <div class="library-empty">
                              <h2>Choose a note</h2>
                              <p>
                                Select a note to read or edit it. Notes remain
                                ordinary Markdown files in the shared folder.
                              </p>
                            </div>
                          }
                        >
                          {(note) => (
                            <NoteEditor
                              note={note}
                              mode={noteMode()}
                              setMode={setNoteMode}
                              saved={async () => {
                                await refresh(selected)
                                await refresh(listing)
                              }}
                              close={() => setSelectedPath("")}
                            />
                          )}
                        </Show>
                      </Loading>
                    }
                  >
                    <div class="editor-panel">
                      <h2>New note</h2>
                      <label class="field">
                        <span>Title</span>
                        <input
                          autofocus
                          value={newTitle()}
                          onInput={(event) =>
                            setNewTitle(event.currentTarget.value)
                          }
                        />
                      </label>
                      <div class="mt-5 flex gap-2">
                        <button
                          class="button"
                          onClick={() => setCreating(false)}
                        >
                          Cancel
                        </button>
                        <button
                          class="button-primary"
                          disabled={!newTitle().trim() || busy()}
                          onClick={create}
                        >
                          Create note
                        </button>
                      </div>
                    </div>
                  </Show>
                </section>
              </div>
            </section>
          )}
        </Show>
      </Loading>
    </main>
  )
}

function NotesStatus(props: {
  workspace: NotesWorkspaceInfo
  busy: boolean
  initialise: () => Promise<void>
}) {
  return (
    <div class="notes-status">
      <p>{props.workspace.dir}</p>
      <Show
        when={!props.workspace.exists}
        fallback={
          <>
            <p>
              {props.workspace.git.repo
                ? `${props.workspace.git.branch ?? "Detached"} · ${props.workspace.git.dirty ? `${props.workspace.git.dirty} uncommitted` : "clean"}`
                : "Not yet a Git repository"}
            </p>
          </>
        }
      >
        <p>The notes folder does not exist yet.</p>
        <button
          class="button-primary"
          disabled={props.busy}
          onClick={props.initialise}
        >
          Create folder
        </button>
      </Show>
    </div>
  )
}

function NoteEditor(props: {
  note: Note
  mode: "write" | "preview"
  setMode: (mode: "write" | "preview") => void
  saved: () => Promise<unknown>
  close: () => void
}) {
  const [title, setTitle] = createSignal(props.note.title)
  const [tags, setTags] = createSignal(props.note.tags.join(", "))
  const [body, setBody] = createSignal(props.note.body)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal("")
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
  const save = async () => {
    setBusy(true)
    setError("")
    try {
      applySavedNote(await api.updateNote(props.note.path, noteInput()))
      await props.saved()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }
  const remove = async () => {
    if (!confirm(`Delete ${title()}?`)) return
    setBusy(true)
    try {
      await api.deleteNote(props.note.path)
      props.close()
      await props.saved()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

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

  const pasteImages = async (event: ClipboardEvent) => {
    const images = [...(event.clipboardData?.files ?? [])].filter((file) =>
      file.type.startsWith("image/"),
    )
    if (!images.length) return
    event.preventDefault()
    setBusy(true)
    setError("")
    try {
      // Attachments belong to a saved note. Save the current draft first so the
      // final update cannot replace text typed before the paste.
      await api.updateNote(props.note.path, noteInput())
      const uploaded = await api.uploadAttachments(props.note.path, images)
      const nextBody = insertAtCursor(
        uploaded.added.map((item) => item.markdown).join("\n"),
      )
      applySavedNote(await api.updateNote(props.note.path, { body: nextBody }))
      await props.saved()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <article class="note-editor">
      <header>
        <div>
          <p class="note-path">{props.note.path}</p>
          <h2>{title()}</h2>
        </div>
        <div class="flex flex-wrap gap-2">
          <div class="note-modes" role="group" aria-label="Note view">
            <button
              class={props.mode === "write" ? "active" : ""}
              onClick={() => props.setMode("write")}
            >
              Write
            </button>
            <button
              class={props.mode === "preview" ? "active" : ""}
              onClick={() => props.setMode("preview")}
            >
              Preview
            </button>
          </div>
          <button class="button" disabled={busy()} onClick={remove}>
            Delete
          </button>
          <button
            class="button-primary"
            disabled={!title().trim() || busy()}
            onClick={save}
          >
            {busy() ? "Saving…" : "Save changes"}
          </button>
        </div>
      </header>
      <Show when={error()}>
        <p class="banner mt-5">{error()}</p>
      </Show>
      <Show
        when={props.mode === "write"}
        fallback={<div class="note-rendered markdown" innerHTML={preview()} />}
      >
        <div class="editor-fields">
          <label class="field">
            <span>Title</span>
            <input
              value={title()}
              onInput={(event) => setTitle(event.currentTarget.value)}
            />
          </label>
          <label class="field">
            <span>Tags</span>
            <input
              value={tags()}
              onInput={(event) => setTags(event.currentTarget.value)}
              placeholder="research, decision"
            />
          </label>
          <label class="field">
            <span>Markdown — paste an image to attach and insert it here</span>
            <textarea
              ref={editor}
              class="note-body"
              value={body()}
              onInput={(event) => setBody(event.currentTarget.value)}
              onPaste={pasteImages}
            />
          </label>
        </div>
      </Show>
    </article>
  )
}
