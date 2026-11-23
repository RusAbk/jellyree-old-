import type { Jellyree } from "./types";
import { toIpcData } from "./ipc-data";

export function createApi(bridge: Jellyree): Jellyree {
  return {
    setLocale: (value) => bridge.setLocale(value),
    settings: {
      get: () => bridge.settings.get(),
      test: (input) => bridge.settings.test(toIpcData(input)),
      save: (input) => bridge.settings.save(toIpcData(input)),
      clear: () => bridge.settings.clear(),
    },
    list: (input) => bridge.list(toIpcData(input)),
    update: (ids, patch) => bridge.update(toIpcData(ids), toIpcData(patch)),
    remove: (ids) => bridge.remove(toIpcData(ids)),
    url: (id) => bridge.url(id),
    share: (id) => bridge.share(id),
    download: (ids) => bridge.download(toIpcData(ids)),
    pickUpload: (folderId, folders, jobId) =>
      bridge.pickUpload(folderId, folders, jobId),
    // Native File objects must reach webUtils unchanged; they are not DTOs.
    dropUpload: (files, folderId, jobId) =>
      bridge.dropUpload(Array.from(files), folderId, jobId),
    importBucket: () => bridge.importBucket(),
    answerUploadConflict: (input) =>
      bridge.answerUploadConflict(toIpcData(input)),
    onUploadConflict: (callback) => bridge.onUploadConflict(callback),
    folders: () => bridge.folders(),
    createFolder: (name, parentId) => bridge.createFolder(name, parentId),
    updateFolder: (id, input) => bridge.updateFolder(id, toIpcData(input)),
    deleteFolder: (id) => bridge.deleteFolder(id),
    stats: () => bridge.stats(),
    onProgress: (callback) => bridge.onProgress(callback),
  };
}

export const api = createApi(window.jellyree);
