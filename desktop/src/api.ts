import type { Jellyree } from "./types";
import { toIpcData } from "./ipc-data";

export function createApi(bridge: Jellyree): Jellyree {
  return {
    thumbnails: {
      get: (revision) => bridge.thumbnails.get(toIpcData(revision)),
      put: (revision, entry, epoch) =>
        bridge.thumbnails.put(
          toIpcData(revision),
          {
            data: entry.data,
            width: entry.width,
            height: entry.height,
            duration: entry.duration,
          },
          epoch,
        ),
      source: (revision) => bridge.thumbnails.source(toIpcData(revision)),
      stats: () => bridge.thumbnails.stats(),
      clear: () => bridge.thumbnails.clear(),
    },
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
    imageSource: (id) => bridge.imageSource(id),
    documentSource: (id, expectedObjectKey) =>
      bridge.documentSource(id, expectedObjectKey),
    saveTextDocument: (id, expectedObjectKey, data) =>
      bridge.saveTextDocument(id, expectedObjectKey, data),
    setDocumentDraft: (owner, dirty) => bridge.setDocumentDraft(owner, dirty),
    videoSource: (revision) => bridge.videoSource(toIpcData(revision)),
    saveVideoFrame: (id, key, timestamp, data) =>
      bridge.saveVideoFrame(id, key, timestamp, data),
    downloadVideoFrame: (id, key, timestamp, data) =>
      bridge.downloadVideoFrame(id, key, timestamp, data),
    exportImage: (id, data, format) => bridge.exportImage(id, data, format),
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
