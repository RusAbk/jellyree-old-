import test from "node:test";
import assert from "node:assert/strict";
import { UploadConflictBroker } from "../electron/upload-conflicts.mjs";

test("conflict responses are bound to the current request and invalid renames leave it pending", async () => {
  const broker = new UploadConflictBroker();
  let question;
  const result = broker.request(
    { name: "photo.jpg" },
    (answer) => {
      if (answer.name === "taken.jpg") throw new Error("name taken");
    },
    (value) => (question = value),
  );
  await assert.rejects(broker.answer({ id: "stale", action: "replace" }));
  await assert.rejects(
    broker.answer({ id: question.id, action: "rename", name: "taken.jpg" }),
    /name taken/,
  );
  assert.equal(broker.pending.id, question.id);
  await broker.answer({
    id: question.id,
    action: "rename",
    name: "new.jpg",
    applyToAll: true,
  });
  assert.deepEqual(await result, {
    action: "rename",
    name: "new.jpg",
    applyToAll: true,
  });
  await assert.rejects(broker.answer({ id: question.id, action: "replace" }));
});

test("closing the upload window cancels a pending decision", async () => {
  const broker = new UploadConflictBroker();
  const answer = broker.request(
    {},
    () => {},
    () => {},
  );
  broker.cancel();
  assert.equal((await answer).action, "cancel");
  assert.equal(broker.pending, null);
});
