<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

/**
 * A full-screen look at one image, with the rest of the set a key away.
 *
 * Notes are mostly evidence — a screenshot of the thing that was wrong, a board
 * exported out of a workshop — and evidence is useless at thumbnail size. The
 * previous answer was a link that opened the file in a new tab, which loses the
 * note, loses the other images, and leaves the reader closing tabs to get back.
 *
 * So: an overlay, over the note, that Escape dismisses. Every way out a reader
 * reaches for works — Escape, the close button, a click on the backdrop — because
 * the one thing a viewer like this must never do is trap somebody in it.
 */
export interface LightboxImage {
  src: string;
  name: string;
}

const props = defineProps<{ images: LightboxImage[]; index: number }>();
const emit = defineEmits<{ close: []; 'update:index': [number] }>();

const current = computed(() => props.images[props.index] ?? null);

/** Reset per image, so a slow one shows its name rather than the last picture. */
const loaded = ref(false);
watch(() => props.index, () => (loaded.value = false));

function step(by: number): void {
  if (props.images.length < 2) return;
  const next = (props.index + by + props.images.length) % props.images.length;
  emit('update:index', next);
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    // Stopped so a parent that also listens for Escape does not act on the same
    // press — closing the viewer is the whole meaning of it while this is open.
    event.stopPropagation();
    emit('close');
    return;
  }
  if (event.key === 'ArrowRight') step(1);
  if (event.key === 'ArrowLeft') step(-1);
}

// On `window`, in the capture phase: the note's textarea and the document both
// handle keys, and this has to win while it is on screen.
onMounted(() => window.addEventListener('keydown', onKeydown, true));
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown, true));
</script>

<template>
  <!-- `.self` so a click that started on the image or the toolbar does not
       dismiss; only the backdrop itself closes. -->
  <div v-if="current" class="overlay lightbox" @click.self="emit('close')">
    <div class="lightbox-bar" @click.stop>
      <span class="mono lightbox-name">{{ current.name }}</span>
      <span v-if="images.length > 1" class="faint">{{ index + 1 }} of {{ images.length }}</span>
      <span class="spacer" />
      <a :href="current.src" target="_blank" rel="noreferrer noopener" title="Open the file in a new tab">
        Open
      </a>
      <button class="lightbox-close" title="Close (Esc)" aria-label="Close" @click="emit('close')">✕</button>
    </div>

    <button
      v-if="images.length > 1"
      class="lightbox-step prev"
      title="Previous (←)"
      aria-label="Previous image"
      @click.stop="step(-1)"
    >
      ‹
    </button>

    <img
      :key="current.src"
      class="lightbox-image"
      :class="{ loading: !loaded }"
      :src="current.src"
      :alt="current.name"
      @click.stop
      @load="loaded = true"
    />

    <button
      v-if="images.length > 1"
      class="lightbox-step next"
      title="Next (→)"
      aria-label="Next image"
      @click.stop="step(1)"
    >
      ›
    </button>
  </div>
</template>
