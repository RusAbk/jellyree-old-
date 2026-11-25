export const noteLimit = 500;

const blocks = ["paragraph", "heading", "bulletList", "orderedList"];
const inline = ["text", "hardBreak"];
const marks = ["bold", "italic", "underline"];
const children = {
  doc: blocks,
  listItem: blocks,
  paragraph: inline,
  heading: inline,
  bulletList: ["listItem"],
  orderedList: ["listItem"],
};

export function noteText(node) {
  if (node.type === "text") return node.text ?? "";
  if (node.type === "hardBreak") return "\n";
  const separator =
    node.type === "paragraph" || node.type === "heading" ? "" : "\n";
  return (node.content ?? []).map(noteText).join(separator);
}

export function normalizeNote(body) {
  const invalid = () => new Error("Некорректный формат заметки.");
  let visited = 0;
  function sanitize(node, allowed, depth) {
    if (!node || !allowed.includes(node.type) || depth > 12 || ++visited > 2500)
      throw invalid();
    const { type } = node;
    if (type === "text") {
      if (
        typeof node.text !== "string" ||
        !node.text ||
        node.text.length > 1000
      )
        throw new Error("Заметка может содержать до 500 символов.");
      if (
        node.marks !== undefined &&
        (!Array.isArray(node.marks) ||
          node.marks.length > marks.length ||
          node.marks.some((mark) => !marks.includes(mark?.type)))
      )
        throw invalid();
      const normalizedMarks = [
        ...new Set(node.marks?.map((mark) => mark.type)),
      ];
      return {
        type,
        text: node.text,
        ...(normalizedMarks.length
          ? { marks: normalizedMarks.map((type) => ({ type })) }
          : {}),
      };
    }
    if (type === "hardBreak") return { type };
    const content = node.content ?? [];
    if (
      !Array.isArray(content) ||
      (["doc", "listItem", "bulletList", "orderedList"].includes(type) &&
        !content.length) ||
      (type === "listItem" && content[0]?.type !== "paragraph")
    )
      throw invalid();
    const normalized = { type };
    if (type === "heading") {
      const level = node.attrs?.level;
      if (![1, 2, 3].includes(level)) throw invalid();
      normalized.attrs = { level };
    }
    if (type === "orderedList") {
      const start = node.attrs?.start ?? 1;
      if (!Number.isSafeInteger(start) || start < 1) throw invalid();
      normalized.attrs = { start };
    }
    if (content.length)
      normalized.content = content.map((child) =>
        sanitize(child, children[type], depth + 1),
      );
    return normalized;
  }
  const note = sanitize(body, ["doc"], 0);
  const text = noteText(note);
  if ([...text].length > noteLimit)
    throw new Error("Заметка может содержать до 500 символов.");
  if (!text.trim()) throw new Error("Введите текст заметки.");
  return note;
}
