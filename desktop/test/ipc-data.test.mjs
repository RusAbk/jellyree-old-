import test from "node:test";
import assert from "node:assert/strict";
import { reactive, ref } from "vue";
import { toIpcData } from "../src/ipc-data.ts";

test("selected files and modal IDs can cross structured-clone boundaries", () => {
  const selection = ref(["delete-me", "keep-me"]);
  const modal = reactive({ ids: [...selection.value], kind: "delete" });
  assert.throws(() => structuredClone(selection.value), {
    name: "DataCloneError",
  });
  assert.throws(() => structuredClone(modal.ids), { name: "DataCloneError" });
  const ids = toIpcData(modal.ids);
  assert.deepEqual(structuredClone(ids), ["delete-me", "keep-me"]);
  selection.value.push("later");
  modal.ids.pop();
  assert.deepEqual(ids, ["delete-me", "keep-me"]);
});

test("nested reactive tags and edits are detached without changing their values", () => {
  const tags = reactive(["travel"]);
  const edits = reactive({ brightness: 110, rotate: 0 });
  const patch = {
    tags,
    adjustments: edits,
    folderId: null,
    favorite: false,
    name: undefined,
  };
  const snapshot = toIpcData(patch);
  assert.deepEqual(structuredClone(snapshot), {
    tags: ["travel"],
    adjustments: { brightness: 110, rotate: 0 },
    folderId: null,
    favorite: false,
    name: undefined,
  });
  tags.push("later");
  edits.brightness = 140;
  assert.equal(snapshot.adjustments.brightness, 110);
  assert.deepEqual(snapshot.tags, ["travel"]);
});
