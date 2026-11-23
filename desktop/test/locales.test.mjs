import test from "node:test";
import assert from "node:assert/strict";
import {
  messages,
  translate,
  normalizeLanguage,
} from "../electron/locales.mjs";

test("English is the fallback and every UI message has English and Spanish with matching placeholders", () => {
  assert.equal(normalizeLanguage(null), "en");
  assert.equal(normalizeLanguage("fr"), "en");
  const slots = (value) =>
    [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
  assert.ok(Object.keys(messages).length > 200);
  for (const [key, translations] of Object.entries(messages)) {
    for (const language of ["en", "es"]) {
      assert.equal(
        typeof translations[language],
        "string",
        `${language}: ${key}`,
      );
      assert.ok(translations[language].trim(), `${language}: ${key}`);
      assert.deepEqual(
        slots(translations[language]),
        slots(key),
        `${language}: ${key}`,
      );
      assert.equal(
        /[А-Яа-яЁё]/.test(translations[language]),
        false,
        `${language}: untranslated UI`,
      );
    }
  }
});

test("language switching translates counts without altering file names or tags", () => {
  assert.equal(
    translate("en", "Применить ко всем {0} совпадениям", { 0: 7 }),
    "Apply to all 7 conflicts",
  );
  assert.equal(
    translate("es", "Применить ко всем {0} совпадениям", { 0: 7 }),
    "Aplicar a los 7 conflictos",
  );
  assert.equal(
    translate("ru", "Применить ко всем {0} совпадениям", { 0: 7 }),
    "Применить ко всем 7 совпадениям",
  );
  assert.equal(
    translate("es", "Папка: {0}", { 0: "Мои фотографии" }),
    "Carpeta: Мои фотографии",
  );
});

test("visible Vue text and all translation keys are covered by the shared catalog", async () => {
  const { readFile, readdir } = await import("node:fs/promises");
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const { parse } = require("@vue/compiler-sfc");
  const { baseParse } = require("@vue/compiler-dom");
  const babel = require("@babel/parser");
  function checkExpression(source, expression, file) {
    let ast;
    try {
      ast = expression
        ? babel.parseExpression(source, { plugins: ["typescript"] })
        : babel.parse(source, {
            sourceType: "module",
            plugins: ["typescript"],
          });
    } catch {
      return;
    }
    function walk(node) {
      if (!node || typeof node !== "object") return;
      if (
        node.type === "CallExpression" &&
        node.callee?.name === "t" &&
        node.arguments[0]?.type === "StringLiteral"
      ) {
        const key = node.arguments[0].value;
        assert.ok(messages[key], `${file}: missing translation for ${key}`);
      }
      for (const [name, value] of Object.entries(node)) {
        if (["loc", "start", "end"].includes(name)) continue;
        if (Array.isArray(value)) value.forEach(walk);
        else if (value && typeof value === "object") walk(value);
      }
    }
    walk(ast);
  }
  for (const file of await readdir(new URL("../src/", import.meta.url))) {
    if (!file.endsWith(".vue")) continue;
    const source = await readFile(
      new URL(`../src/${file}`, import.meta.url),
      "utf8",
    );
    const { descriptor } = parse(source);
    checkExpression(descriptor.scriptSetup?.content || "", false, file);
    const root = baseParse(descriptor.template.content, {
      isVoidTag: (tag) =>
        ["input", "img", "br", "hr", "meta", "link", "source"].includes(tag),
    });
    function visit(node, parent) {
      if (
        node.type === 2 &&
        !(file === "LanguageSelect.vue" && parent?.tag === "option")
      )
        assert.equal(
          /[А-Яа-яЁё]/.test(node.content),
          false,
          `${file}: untranslated text ${node.content.trim()}`,
        );
      if (node.type === 5) checkExpression(node.content.content, true, file);
      for (const prop of node.props || []) {
        if (prop.type === 6 && prop.value)
          assert.equal(
            /[А-Яа-яЁё]/.test(prop.value.content),
            false,
            `${file}: untranslated attribute ${prop.name}`,
          );
        if (prop.type === 7 && prop.exp)
          checkExpression(prop.exp.content, true, file);
      }
      for (const child of node.children || []) visit(child, node);
    }
    visit(root);
  }
});
