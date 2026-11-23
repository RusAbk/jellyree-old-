<script setup lang="ts">
import { computed, ref } from "vue";
import { marked } from "marked";
import DOMPurify from "dompurify";
const props = defineProps<{ text: string }>();
const root = ref<HTMLElement>();
const purify = DOMPurify(window);
purify.addHook("afterSanitizeAttributes", (node) => {
  if (node instanceof HTMLInputElement) {
    if (node.type !== "checkbox") node.remove();
    else node.disabled = true;
  }
});
const html = computed(() =>
  purify.sanitize(marked.parse(props.text, { async: false, gfm: true }), {
    ALLOWED_TAGS: [
      "p",
      "br",
      "hr",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "strong",
      "em",
      "del",
      "s",
      "blockquote",
      "pre",
      "code",
      "ul",
      "ol",
      "li",
      "table",
      "thead",
      "tbody",
      "tr",
      "th",
      "td",
      "a",
      "input",
      "sup",
      "sub",
      "details",
      "summary",
      "kbd",
    ],
    ALLOWED_ATTR: [
      "href",
      "title",
      "start",
      "type",
      "checked",
      "disabled",
      "align",
      "id",
    ],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
  }),
);
function link(event: MouseEvent) {
  const anchor = (event.target as HTMLElement).closest("a");
  if (!anchor) return;
  event.preventDefault();
  const href = anchor.getAttribute("href");
  if (!href?.startsWith("#")) return;
  let id: string;
  try {
    id = decodeURIComponent(href.slice(1));
  } catch {
    return;
  }
  [...(root.value?.querySelectorAll<HTMLElement>("[id]") || [])]
    .find((el) => el.id === id)
    ?.scrollIntoView({ block: "start" });
}
</script>
<template>
  <article
    ref="root"
    class="markdown-content"
    @click="link"
    v-html="html"
  ></article>
</template>
