<script setup lang="ts">
import { computed, ref } from 'vue';
import type { Comparison } from '@shared/types';
import { imageUrl } from '../api';

const props = defineProps<{ comparison: Comparison; open: boolean }>();
const emit = defineEmits<{ 'update:open': [boolean] }>();

type Mode = 'side-by-side' | 'slider' | 'diff' | 'before' | 'after';

const before = computed(() => imageUrl(props.comparison.beforePath));
const after = computed(() => imageUrl(props.comparison.afterPath));
const diff = computed(() => imageUrl(props.comparison.diffPath));

// A `before`-phase capture has only the reference image, so the comparison
// modes would all show the same thing. Default to whatever is meaningful.
const hasPair = computed(() => Boolean(before.value && after.value));
const mode = ref<Mode>(hasPair.value ? 'side-by-side' : 'before');

const sliderPosition = ref(50);
const sliderElement = ref<HTMLElement | null>(null);
const dragging = ref(false);

function positionFromEvent(event: PointerEvent): void {
  const element = sliderElement.value;
  if (!element) return;

  const bounds = element.getBoundingClientRect();
  const ratio = (event.clientX - bounds.left) / bounds.width;
  sliderPosition.value = Math.min(100, Math.max(0, ratio * 100));
}

function startDrag(event: PointerEvent): void {
  dragging.value = true;
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  positionFromEvent(event);
}

function drag(event: PointerEvent): void {
  if (dragging.value) positionFromEvent(event);
}

function endDrag(event: PointerEvent): void {
  dragging.value = false;
  (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
}

// The clipped "after" image must render at the full container width so it stays
// registered against the "before" underneath. Its own box is only
// `sliderPosition%` wide, so it needs the reciprocal — guarded, because a handle
// at 0 would otherwise divide by zero.
const afterImageWidth = computed(() => `${10000 / Math.max(sliderPosition.value, 0.01)}%`);

const percentLabel = computed(() => {
  const value = props.comparison.percentChanged;
  return value === null ? null : `${value.toFixed(2)}% of pixels`;
});

const availableModes = computed<{ id: Mode; label: string; enabled: boolean }[]>(() => [
  { id: 'side-by-side', label: 'Side by side', enabled: hasPair.value },
  { id: 'slider', label: 'Slider', enabled: hasPair.value },
  { id: 'diff', label: 'Diff', enabled: Boolean(diff.value) },
  { id: 'before', label: 'Before', enabled: Boolean(before.value) },
  { id: 'after', label: 'After', enabled: Boolean(after.value) },
]);

/** A one-line stand-in for the images while the card is collapsed, so a shut
 *  card still says what happened rather than only naming the scenario. */
const collapsedSummary = computed(() => {
  switch (props.comparison.status) {
    case 'changed':
      return 'Visual difference';
    case 'failed':
      return 'Capture failed';
    case 'new-baseline':
      return 'Reference capture';
    default:
      return 'No visual difference';
  }
});
</script>

<template>
  <div class="comparison">
    <!-- The whole head toggles, but the mode switcher inside it must not — its
         own clicks are stopped below. -->
    <div class="comparison-head" :class="{ collapsed: !open }" @click="emit('update:open', !open)">
      <button
        class="disclosure"
        :aria-expanded="open"
        :title="open ? 'Collapse' : 'Expand'"
        @click.stop="emit('update:open', !open)"
      >
        <span class="chevron" :class="{ open }">›</span>
      </button>

      <strong class="mono">{{ comparison.scenario }}</strong>
      <span class="badge" :class="comparison.status">{{ comparison.status }}</span>
      <span v-if="percentLabel" class="faint">{{ percentLabel }}</span>
      <span
        v-if="comparison.browserLogChangeCount"
        class="faint"
        :title="'Browser console output changed'"
      >
        · {{ comparison.browserLogChangeCount }} console change(s)
      </span>
      <span v-if="!open && !percentLabel" class="faint">{{ collapsedSummary }}</span>

      <span class="spacer" />

      <div v-if="open" class="modes" @click.stop>
        <button
          v-for="option in availableModes"
          :key="option.id"
          :class="{ active: mode === option.id }"
          :disabled="!option.enabled"
          @click="mode = option.id"
        >
          {{ option.label }}
        </button>
      </div>
    </div>

    <template v-if="open">
      <p v-if="comparison.description" class="faint" style="padding: 0 14px; margin: 10px 0 0">
        {{ comparison.description }}
      </p>

      <!-- Side by side -->
      <div v-if="mode === 'side-by-side'" class="shots side-by-side">
        <figure class="shot" style="margin: 0">
          <figcaption>Before</figcaption>
          <img v-if="before" :src="before" :alt="`${comparison.scenario} before`" />
          <p v-else class="missing">No before image</p>
        </figure>
        <figure class="shot" style="margin: 0">
          <figcaption>After</figcaption>
          <img v-if="after" :src="after" :alt="`${comparison.scenario} after`" />
          <p v-else class="missing">No after image</p>
        </figure>
      </div>

      <!-- Slider -->
      <div v-else-if="mode === 'slider'" class="shots">
        <div
          ref="sliderElement"
          class="slider"
          @pointerdown="startDrag"
          @pointermove="drag"
          @pointerup="endDrag"
          @pointercancel="endDrag"
        >
          <img :src="before!" :alt="`${comparison.scenario} before`" />
          <div class="slider-after" :style="{ width: `${sliderPosition}%` }">
            <!-- Sized to the container, not its own clip, so the two images stay
                 registered pixel-for-pixel as the handle moves. -->
            <img
              :src="after!"
              :alt="`${comparison.scenario} after`"
              :style="{ width: afterImageWidth }"
            />
          </div>
          <div class="slider-handle" :style="{ left: `${sliderPosition}%` }" />
        </div>
        <input
          v-model.number="sliderPosition"
          class="slider-range"
          type="range"
          min="0"
          max="100"
          aria-label="Reveal the after image"
        />
        <p class="faint" style="margin: 0; text-align: center">
          Left of the handle is <strong>after</strong>, right is <strong>before</strong>.
        </p>
      </div>

      <!-- Single image modes -->
      <div v-else class="shots">
        <figure class="shot" style="margin: 0">
          <img
            v-if="mode === 'diff' && diff"
            :src="diff"
            :alt="`${comparison.scenario} diff`"
          />
          <img
            v-else-if="mode === 'before' && before"
            :src="before"
            :alt="`${comparison.scenario} before`"
          />
          <img
            v-else-if="mode === 'after' && after"
            :src="after"
            :alt="`${comparison.scenario} after`"
          />
          <p v-else class="missing">Not captured</p>
        </figure>
      </div>
    </template>
  </div>
</template>
