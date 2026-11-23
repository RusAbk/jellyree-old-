export function decodeText(data: Uint8Array, encoding = "auto") {
  return textDocumentInfo(data, encoding).text;
}
export function textDocumentInfo(data: Uint8Array, encoding = "auto") {
  if (encoding === "auto") {
    encoding =
      data[0] === 0xff && data[1] === 0xfe
        ? "utf-16le"
        : data[0] === 0xfe && data[1] === 0xff
          ? "utf-16be"
          : "utf-8";
  }
  const raw = new TextDecoder(encoding).decode(data);
  return {
    text: raw.replace(/\r\n?/g, "\n"),
    lineEnding: raw.match(/\r\n|\r|\n/)?.[0] || "\n",
    bom: data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf,
  };
}
export function encodeTextDocument(
  text: string,
  info: { lineEnding: string; bom: boolean },
) {
  return new TextEncoder().encode(
    (info.bom ? "\uFEFF" : "") + text.replace(/\n/g, info.lineEnding),
  );
}
export function textMatches(text: string, query: string) {
  const parts: { text: string; match: number }[] = [];
  if (!query) return [{ text, match: -1 }];
  // Bound the number of DOM nodes, keeping the complete remaining text readable.
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(escaped, "giu");
  let end = 0,
    count = 0;
  for (const result of text.matchAll(pattern)) {
    parts.push(
      { text: text.slice(end, result.index), match: -1 },
      { text: result[0], match: count++ },
    );
    end = result.index + result[0].length;
    if (count === 1000) break;
  }
  parts.push({ text: text.slice(end), match: -1 });
  return parts;
}
