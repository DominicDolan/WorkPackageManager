<script setup lang="ts">
import { computed, ref } from 'vue';
import { renderMarkdown } from '../markdown';

/**
 * A block of stored prose, rendered.
 *
 * Nearly all the text this app displays was written as Markdown — an agent's
 * findings, a task description filed by `/plan-tasks`, an issue body — and until
 * now most of it was shown as the raw source. This renders it with the same
 * escaping renderer the notes preview uses, so the only markup on screen is the
 * markup that renderer emits.
 *
 * The copy button copies the **source**, not the rendered text: the reason to
 * copy any of this is to paste it into a prompt, an issue or another editor,
 * and all three want the Markdown back.
 */
const props = defineProps<{
  source: string;
  /** Hidden where the surrounding view already offers its own copy control. */
  copyable?: boolean;
}>();

const rendered = computed(() => renderMarkdown(props.source));

const state = ref<'idle' | 'copied' | 'failed'>('idle');

async function copy(): Promise<void> {
  try {
    await navigator.clipboard.writeText(props.source);
    state.value = 'copied';
  } catch {
    // Clipboard access can be refused; the source is on screen to select.
    state.value = 'failed';
  }
  setTimeout(() => (state.value = 'idle'), 1600);
}
</script>

<template>
  <div class="panel markdown-block">
    <button
      v-if="copyable !== false"
      class="markdown-copy"
      title="Copy as Markdown"
      @click="copy"
    >
      {{ state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : 'Copy' }}
    </button>
    <!-- Rendered by this app's own renderer, which escapes the source before any
         rule runs — safe for prose an agent or another clone wrote. -->
    <div class="markdown" v-html="rendered" />
  </div>
</template>
