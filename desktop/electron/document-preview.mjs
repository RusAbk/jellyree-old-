/** @param {{name: string, mime_type: string}} file */
export function documentKind(file) {
  const name = file.name.toLowerCase(),
    mime = file.mime_type.split(";")[0].trim().toLowerCase();
  if (
    /\.(md|markdown)$/.test(name) ||
    ["text/markdown", "text/x-markdown"].includes(mime)
  )
    return "markdown";
  if (name.endsWith(".pdf") || mime === "application/pdf") return "pdf";
  if (name.endsWith(".txt") || mime === "text/plain") return "text";
  return null;
}
export const documentLimits = {
  pdf: 64 * 1024 * 1024,
  text: 4 * 1024 * 1024,
  markdown: 4 * 1024 * 1024,
};
