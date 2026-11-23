import test from "node:test";
import assert from "node:assert/strict";
import { canMoveFolder } from "../src/drag-items.ts";

test("folder drops allow another branch or root and reject self/descendants", () => {
  const folders = [
    { id: "album", parent_id: null },
    { id: "child", parent_id: "album" },
    { id: "grandchild", parent_id: "child" },
    { id: "other", parent_id: null },
  ];
  assert.equal(canMoveFolder(folders, "album", "other"), true);
  assert.equal(canMoveFolder(folders, "grandchild", null), true);
  assert.equal(canMoveFolder(folders, "child", "other"), true);
  for (const target of ["album", "child", "grandchild", "missing"]) {
    assert.equal(canMoveFolder(folders, "album", target), false);
  }
  assert.equal(canMoveFolder(folders, "missing", null), false);
});

test("corrupt folder ancestry cannot hang dragover or create a cycle", () => {
  const folders = [
    { id: "source", parent_id: null },
    { id: "a", parent_id: "b" },
    { id: "b", parent_id: "a" },
  ];
  assert.equal(canMoveFolder(folders, "source", "a"), false);
});
