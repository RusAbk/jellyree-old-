import type { Folder } from "./types";
export const INTERNAL_DRAG_TYPE = "application/x-jellyree-items";
export type DragItems =
  { kind: "files"; ids: string[] } | { kind: "folder"; id: string };
export function canMoveFolder(
  folders: ReadonlyArray<Pick<Folder, "id" | "parent_id">>,
  source: string,
  target: string | null,
) {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  if (!byId.has(source) || (target !== null && !byId.has(target))) return false;
  const visited = new Set<string>();
  let parent = target;
  while (parent !== null) {
    if (parent === source || visited.has(parent)) return false;
    visited.add(parent);
    parent = byId.get(parent)?.parent_id ?? null;
  }
  return true;
}
