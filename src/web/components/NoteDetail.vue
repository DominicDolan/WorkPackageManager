<script setup lang="ts">
import { computed, ref, watch } from "vue"
import type { Note } from "@shared/types"
import { api, noteAssetUrl } from "../api"
import { renderMarkdown } from "../markdown"
import ImageLightbox, { type LightboxImage } from "./ImageLightbox.vue"

const props = defineProps<{ note: Note }>()
const emit = defineEmits<{
  changed: [Note]
  deleted: [string]
  renamed: [string]
}>()

type Mode = "write" | "split" | "read"

const busy = ref<string | null>(null)
const error = ref<string | null>(null)
const mode = ref<Mode>("split")
const editor = ref<HTMLTextAreaElement | null>(null)
const dragging = ref(false)

/** The note as it is being edited. Saved explicitly, like an investigation's
 *  brief: a note is somebody's thinking, and losing a half-written paragraph to
 *  an unlucky click is the one failure that would stop it being trusted. */
const draft = ref({ title: "", body: "", tags: "" })

watch(
  () => props.note.path,
  () => {
    draft.value = {
      title: props.note.title,
      body: props.note.body,
      tags: props.note.tags.join(", "),
    }
    error.value = null
  },
  { immediate: true },
)

// A note changed on disk — by `tasks notes edit`, an agent, or a `git pull` —
// should show up, but never over the top of unsaved typing.
watch(
  () => props.note.body,
  (body) => {
    if (!dirty.value) draft.value.body = body
  },
)

const tagList = computed(() =>
  draft.value.tags
    .split(",")
    .map((tag) => tag.trim().replace(/^#/, ""))
    .filter(Boolean),
)

const dirty = computed(
  () =>
    draft.value.title !== props.note.title ||
    draft.value.body !== props.note.body ||
    tagList.value.join(",") !== props.note.tags.join(","),
)

/** Links inside a note are relative to the note, so the preview asks the server
 *  to resolve each one rather than guessing at the path itself. */
const preview = computed(() =>
  renderMarkdown(draft.value.body, {
    resolveLink: (href) => noteAssetUrl(props.note.path, href),
  }),
)

const words = computed(() =>
  draft.value.body.trim() ? draft.value.body.trim().split(/\s+/).length : 0,
)

async function run(label: string, action: () => Promise<Note>): Promise<void> {
  busy.value = label
  error.value = null
  try {
    emit("changed", await action())
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught)
  } finally {
    busy.value = null
  }
}

const save = () =>
  run("save", () =>
    api.updateNote(props.note.path, {
      title: draft.value.title,
      body: draft.value.body,
      tags: tagList.value,
    }),
  )

async function rename(): Promise<void> {
  const next = prompt(
    "Move or rename this note. Folders are created as needed.",
    props.note.path,
  )
  if (!next || next === props.note.path) return

  busy.value = "rename"
  error.value = null
  try {
    const note = await api.updateNote(props.note.path, { path: next })
    emit("renamed", note.path)
    emit("changed", note)
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught)
  } finally {
    busy.value = null
  }
}

async function remove(): Promise<void> {
  // Only the uploads go with the note; images found in its folder stay where
  // they are, so promising to delete them would be a lie.
  const uploads = props.note.attachments.filter(
    (attachment) => attachment.uploaded,
  ).length
  const extra = uploads
    ? ` Its ${uploads} uploaded attachment(s) go with it.`
    : ""
  if (!confirm(`Delete ${props.note.path}?${extra}`)) return

  busy.value = "delete"
  try {
    await api.deleteNote(props.note.path)
    emit("deleted", props.note.path)
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught)
  } finally {
    busy.value = null
  }
}

/* ------------------------------------------------------------ attachments */

/** Drop the snippet where the caret is, so a pasted screenshot lands in the
 *  paragraph being written rather than at the end of the note. */
function insertAtCursor(text: string): void {
  const field = editor.value
  if (!field) {
    draft.value.body = `${draft.value.body.replace(/\s+$/, "")}\n\n${text}\n`
    return
  }

  const start = field.selectionStart
  const end = field.selectionEnd
  const before = draft.value.body.slice(0, start)
  const after = draft.value.body.slice(end)
  const padded = `${before}${before && !before.endsWith("\n") ? "\n\n" : ""}${text}\n${after}`
  draft.value.body = padded

  // Vue rewrites the value on the next tick; restore the caret after it does.
  const caret = padded.length - after.length
  requestAnimationFrame(() => {
    field.focus()
    field.setSelectionRange(caret, caret)
  })
}

/**
 * Upload files and link them into the body.
 *
 * The upload targets the saved note, so anything typed but not saved has to be
 * written first — otherwise saving afterwards would overwrite the file the
 * server just wrote the link into.
 */
async function upload(files: File[]): Promise<void> {
  if (!files.length) return

  busy.value = "upload"
  error.value = null
  try {
    if (dirty.value) {
      await api.updateNote(props.note.path, {
        title: draft.value.title,
        body: draft.value.body,
        tags: tagList.value,
      })
    }

    const result = await api.uploadAttachments(props.note.path, files)
    insertAtCursor(result.added.map((added) => added.markdown).join("\n"))
    emit(
      "changed",
      await api.updateNote(props.note.path, { body: draft.value.body }),
    )
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught)
  } finally {
    busy.value = null
  }
}

function onPaste(event: ClipboardEvent): void {
  const files = [...(event.clipboardData?.files ?? [])]
  if (!files.length) return
  // Only take over the paste when it is actually a file: pasted text must keep
  // the browser's own behaviour, caret and undo history included.
  event.preventDefault()
  void upload(files)
}

function onDrop(event: DragEvent): void {
  dragging.value = false
  const files = [...(event.dataTransfer?.files ?? [])]
  if (!files.length) return
  event.preventDefault()
  void upload(files)
}

function onPick(event: Event): void {
  const input = event.target as HTMLInputElement
  void upload([...(input.files ?? [])]).then(() => (input.value = ""))
}

async function detach(name: string): Promise<void> {
  if (
    !confirm(
      `Delete the attachment '${name}'? Links to it in the note will break.`,
    )
  )
    return
  await run("detach", () => api.deleteAttachment(props.note.path, name))
}

/* ---------------------------------------------------------------- viewing */

/**
 * Every image of this note, in the order the attachments list shows them, so
 * the viewer can step through the set from whichever one was clicked.
 */
const gallery = computed<LightboxImage[]>(() =>
  props.note.attachments
    .filter((attachment) => attachment.isImage)
    .map((attachment) => ({
      src: noteAssetUrl(props.note.path, attachment.href),
      name: attachment.name,
    })),
)

/** Which image is open, or null for none. Cleared when the note changes, so
 *  switching notes underneath the viewer cannot leave a stray image on screen. */
const viewing = ref<{ images: LightboxImage[]; index: number } | null>(null)
watch(
  () => props.note.path,
  () => (viewing.value = null),
)

function view(src: string, name: string): void {
  // An image already in the gallery opens *as part of* it, so the arrows work.
  // One that is not — a note linking someone else's attachment, or a remote URL
  // — opens on its own rather than being wedged into a set it is not in.
  const index = gallery.value.findIndex((image) => image.src === src)
  viewing.value =
    index === -1
      ? { images: [{ src, name }], index: 0 }
      : { images: gallery.value, index }
}

/**
 * Open an image clicked in the rendered preview.
 *
 * The preview is `v-html`, so its images cannot carry a Vue handler; the pane
 * listens instead and checks what was hit. `currentSrc` rather than the `src`
 * attribute, because that is the URL the browser actually resolved.
 */
function onPreviewClick(event: MouseEvent): void {
  const target = event.target
  if (!(target instanceof HTMLImageElement)) return
  event.preventDefault()
  view(target.currentSrc || target.src, target.alt || "image")
}

const formatDate = (value: string) => new Date(value).toLocaleString()
const formatSize = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${Math.round(bytes / 1024)} KB`
      : `${(bytes / 1048576).toFixed(1)} MB`
</script>

<template>
  <section
    class="detail note-detail"
    @dragover.prevent="dragging = true"
    @dragleave="dragging = false"
    @drop="onDrop"
  >
    <p v-if="error" class="banner">{{ error }}</p>

    <div class="detail-header">
      <input
        v-model="draft.title"
        class="title-input"
        aria-label="Note title"
        @keyup.enter="dirty && save()"
      />
    </div>

    <div class="row" style="flex-wrap: wrap; margin-bottom: 10px">
      <button
        class="mono note-path"
        :title="`Move or rename ${note.path}`"
        @click="rename"
      >
        {{ note.path }}
      </button>
      <span class="faint">Updated {{ formatDate(note.updatedAt) }}</span>
      <span class="spacer" />
      <div class="modes" role="group" aria-label="Editing mode">
        <button :class="{ active: mode === 'write' }" @click="mode = 'write'">
          Write
        </button>
        <button :class="{ active: mode === 'split' }" @click="mode = 'split'">
          Split
        </button>
        <button :class="{ active: mode === 'read' }" @click="mode = 'read'">
          Read
        </button>
      </div>
      <button class="danger" :disabled="!!busy" @click="remove">Delete</button>
    </div>

    <div class="row" style="margin-bottom: 10px">
      <input
        v-model="draft.tags"
        class="tag-input"
        aria-label="Tags, comma separated"
        placeholder="tags, comma separated"
      />
      <button
        class="primary"
        :disabled="!dirty || busy === 'save'"
        @click="save"
      >
        {{ busy === "save" ? "Saving…" : dirty ? "Save" : "Saved" }}
      </button>
    </div>

    <!-- --------------------------------------------------------- the note -->
    <div class="note-panes" :class="[mode, { dropping: dragging }]">
      <textarea
        v-if="mode !== 'read'"
        ref="editor"
        v-model="draft.body"
        class="note-editor mono"
        aria-label="Note body"
        placeholder="Markdown. Paste or drop an image to attach it."
        spellcheck="true"
        @paste="onPaste"
        @keydown.ctrl.s.prevent="dirty && save()"
        @keydown.meta.s.prevent="dirty && save()"
      />
      <!-- The preview is rendered by this app's own renderer, which escapes the
           source before any rule runs, so the only markup here is its own. -->
      <div
        v-if="mode !== 'write'"
        class="note-preview markdown"
        @click="onPreviewClick"
        v-html="preview"
      />
    </div>

    <div class="row note-footer">
      <span class="faint">{{ words }} words</span>
      <span v-if="dirty" class="faint">Unsaved changes — Ctrl+S saves.</span>
      <span class="spacer" />
      <label class="attach-button">
        <input type="file" multiple hidden @change="onPick" />
        <span>{{ busy === "upload" ? "Uploading…" : "Attach files" }}</span>
      </label>
    </div>

    <ImageLightbox
      v-if="viewing"
      :images="viewing.images"
      :index="viewing.index"
      @update:index="viewing.index = $event"
      @close="viewing = null"
    />

    <!-- ------------------------------------------------------ attachments -->
    <div v-if="note.attachments.length" class="section">
      <h3>Attachments ({{ note.attachments.length }})</h3>
      <div class="panel attachment-grid">
        <figure
          v-for="attachment in note.attachments"
          :key="attachment.path"
          class="attachment"
        >
          <!-- An image opens in the viewer, over the note. Anything else is a
               file the browser must decide what to do with, so it keeps the
               link it always had. -->
          <button
            v-if="attachment.isImage"
            class="attachment-open"
            :title="`View ${attachment.name}`"
            @click="
              view(noteAssetUrl(note.path, attachment.href), attachment.name)
            "
          >
            <img
              :src="noteAssetUrl(note.path, attachment.href)"
              :alt="attachment.name"
            />
          </button>
          <a
            v-else
            :href="noteAssetUrl(note.path, attachment.href)"
            target="_blank"
            rel="noreferrer noopener"
          >
            <span class="attachment-file" aria-hidden="true">📎</span>
          </a>
          <figcaption>
            <span class="mono">{{ attachment.name }}</span>
            <span class="faint">{{ formatSize(attachment.size) }}</span>
            <!-- Remove is offered only for files this app uploaded. One that was
                 found sitting in the folder may belong to another note, or be
                 the reason the folder exists; deleting it is a file-manager
                 job, not a side effect of viewing a note. -->
            <button
              v-if="attachment.uploaded"
              class="danger"
              :disabled="!!busy"
              @click="detach(attachment.name)"
            >
              Remove
            </button>
            <span
              v-else
              class="faint"
              title="Found in this note's folder, not uploaded here"
            >
              in folder
            </span>
          </figcaption>
        </figure>
      </div>
    </div>
  </section>
</template>
