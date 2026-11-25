import { t } from "./locales.mjs";
import { randomUUID } from "node:crypto";

export class UploadConflictBroker {
  pending = null;
  request(info, validate, send, signal) {
    signal?.throwIfAborted();
    if (this.pending)
      throw new Error(t("Дождитесь решения предыдущего совпадения."));
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const abort = () => {
        if (this.pending?.id === id) this.cancel();
      };
      this.pending = {
        id,
        validate,
        settling: false,
        resolve(value) {
          signal?.removeEventListener("abort", abort);
          resolve(value);
        },
      };
      signal?.addEventListener("abort", abort, { once: true });
      try {
        send({ ...info, id });
      } catch (error) {
        signal?.removeEventListener("abort", abort);
        this.pending = null;
        reject(error);
      }
    });
  }
  async answer(input) {
    const pending = this.pending;
    if (!pending || input?.id !== pending.id)
      throw new Error(t("Этот запрос уже закрыт."));
    if (pending.settling)
      throw new Error(t("Дождитесь завершения текущих операций."));
    if (!["skip", "rename", "replace", "cancel"].includes(input.action))
      throw new Error(t("Некорректное решение для совпадающего файла."));
    pending.settling = true;
    try {
      const answer = {
        action: input.action,
        applyToAll: input.applyToAll === true,
        name: input.name,
      };
      await pending.validate(answer);
      if (this.pending !== pending)
        throw new Error(t("Этот запрос уже закрыт."));
      this.pending = null;
      pending.resolve(answer);
    } finally {
      pending.settling = false;
    }
  }
  cancel() {
    const pending = this.pending;
    this.pending = null;
    pending?.resolve({ action: "cancel", applyToAll: false });
  }
}
