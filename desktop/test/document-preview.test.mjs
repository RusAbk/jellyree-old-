import test from "node:test";
import assert from "node:assert/strict";
import { documentKind } from "../electron/document-preview.mjs";
import {
  decodeText,
  textMatches,
  textDocumentInfo,
  encodeTextDocument,
} from "../src/document-text.ts";
test("text editing preserves line endings and UTF-8 BOM, and explicitly converts legacy text to UTF-8", () => {
  for (const ending of ["\n", "\r\n", "\r"]) {
    const data = new TextEncoder().encode(`\uFEFFfirst${ending}second`),
      info = textDocumentInfo(data);
    assert.equal(info.text, "first\nsecond");
    assert.equal(info.lineEnding, ending);
    assert.deepEqual(encodeTextDocument(info.text, info), data);
  }
  const info = textDocumentInfo(
    new Uint8Array([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]),
    "windows-1251",
  );
  assert.equal(
    new TextDecoder("utf-8", { fatal: true }).decode(
      encodeTextDocument(info.text, info),
    ),
    "Привет",
  );
});
test("document detection handles imported MIME types, uppercase extensions and Markdown precedence", () => {
  for (const [name, mime_type, kind] of [
    ["Guide.PDF", "application/octet-stream", "pdf"],
    ["notes.TXT", "application/octet-stream", "text"],
    ["readme.MD", "text/plain", "markdown"],
    ["readme.markdown", "application/octet-stream", "markdown"],
    ["object", "application/pdf; charset=binary", "pdf"],
    ["object", "text/markdown", "markdown"],
    ["photo.png", "image/png", null],
    ["index.html", "text/html", null],
  ])
    assert.equal(documentKind({ name, mime_type }), kind);
});
test("text decoding preserves UTF-8, detects UTF-16 BOMs, supports Cyrillic and Western legacy encodings", () => {
  const text = "Привет, España\r\nSecond line";
  assert.equal(
    decodeText(new TextEncoder().encode(text)),
    text.replace("\r\n", "\n"),
  );
  assert.equal(
    decodeText(new Uint8Array([255, 254, 65, 0, 10, 0, 66, 0])),
    "A\nB",
  );
  assert.equal(
    decodeText(new Uint8Array([254, 255, 0, 65, 0, 10, 0, 66])),
    "A\nB",
  );
  assert.equal(
    decodeText(
      new Uint8Array([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]),
      "windows-1251",
    ),
    "Привет",
  );
  assert.equal(
    decodeText(new Uint8Array([69, 115, 112, 97, 241, 97]), "windows-1252"),
    "España",
  );
  assert.equal(decodeText(new Uint8Array()), "");
});
test("document search treats expressions literally and bounds highlights without dropping content", () => {
  const text = "a+b <script> A+B";
  const parts = textMatches(text, "a+b");
  assert.equal(parts.filter((p) => p.match >= 0).length, 2);
  assert.equal(parts.map((p) => p.text).join(""), text);
  assert.equal(
    textMatches("banana", "[").filter((p) => p.match >= 0).length,
    0,
  );
  const many = textMatches("a".repeat(5000), "a");
  assert.equal(many.filter((p) => p.match >= 0).length, 1000);
  assert.equal(many.map((p) => p.text).join(""), "a".repeat(5000));
});
