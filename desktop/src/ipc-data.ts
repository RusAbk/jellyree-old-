import { toRaw } from "vue";

// Electron's contextBridge/IPC cannot copy Vue Proxy objects. Build a detached
// DTO in the renderer, before crossing either boundary. toRaw alone is shallow.
export function toIpcData<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  const raw = toRaw(value);
  if (Array.isArray(raw)) return raw.map((item) => toIpcData(item)) as T;
  if (
    Object.getPrototypeOf(raw) !== Object.prototype &&
    Object.getPrototypeOf(raw) !== null
  ) {
    throw new TypeError("IPC data must contain plain objects and arrays.");
  }
  return Object.fromEntries(
    Object.entries(raw).map(([key, item]) => [key, toIpcData(item)]),
  ) as T;
}
