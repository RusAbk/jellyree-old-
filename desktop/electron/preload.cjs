const { contextBridge, ipcRenderer, webUtils } = require("electron");
const invoke = async (channel, ...args) => {
  const result = await ipcRenderer.invoke(`jellyree:${channel}`, ...args);
  if (!result.ok) throw new Error(result.error);
  return result.value;
};
contextBridge.exposeInMainWorld("jellyree", {
  setLocale: (value) => invoke("app:locale", value),
  settings: {
    get: () => invoke("settings:get"),
    test: (input) => invoke("settings:test", input),
    save: (input) => invoke("settings:save", input),
    select: (id) => invoke("settings:select", id),
    clear: (id) => invoke("settings:clear", id),
  },
  list: (input) => invoke("files:list", input),
  timelineBounds: (kind) => invoke("files:timeline-bounds", kind),
  update: (ids, patch) => invoke("files:update", ids, patch),
  remove: (ids) => invoke("files:delete", ids),
  url: (id) => invoke("files:url", id),
  imageSource: (id, requestId, pxz) =>
    invoke("files:image-source", id, requestId, pxz),
  cancelPreview: (requestId) => invoke("previews:cancel", requestId),
  releaseMedia: (url) => invoke("media:release", url),
  documentSource: (id, expectedObjectKey) =>
    invoke("files:document-source", id, expectedObjectKey),
  saveTextDocument: (id, expectedObjectKey, data) =>
    invoke("files:save-text-document", id, expectedObjectKey, data),
  saveEditedImage: (id, expectedObjectKey, data) =>
    invoke("files:save-edited-image", id, expectedObjectKey, data),
  setDocumentDraft: (owner, dirty) => invoke("documents:draft", owner, dirty),
  videoSource: (revision) => invoke("files:video-source", revision),
  duplicatePhoto: (id, expectedObjectKey) =>
    invoke("files:duplicate-photo", id, expectedObjectKey),
  saveVideoFrame: (id, expectedObjectKey, timestamp, data) =>
    invoke("files:save-video-frame", id, expectedObjectKey, timestamp, data),
  downloadVideoFrame: (id, expectedObjectKey, timestamp, data) =>
    invoke(
      "files:download-video-frame",
      id,
      expectedObjectKey,
      timestamp,
      data,
    ),
  thumbnails: {
    get: (revision) => invoke("thumbnails:get", revision),
    dimensions: (revisions) => invoke("thumbnails:dimensions", revisions),
    put: (revision, entry, epoch) =>
      invoke("thumbnails:put", revision, entry, epoch),
    source: (revision, requestId) =>
      invoke("thumbnails:source", revision, requestId),
    stats: () => invoke("thumbnails:stats"),
    clear: () => invoke("thumbnails:clear"),
  },
  exportImage: (id, data, format) =>
    invoke("files:export-image", id, data, format),
  share: (id) => invoke("files:share", id),
  download: (ids) => invoke("files:download", ids),
  pickUpload: (folderId, folders, jobId) =>
    invoke("files:pick-upload", folderId, folders, jobId),
  dropUpload: (files, folderId, jobId) =>
    invoke(
      "files:drop-upload",
      Array.from(files, (file) => webUtils.getPathForFile(file)),
      folderId,
      jobId,
    ),
  retryUpload: (ids, jobId) => invoke("files:retry-upload", ids, jobId),
  importBucket: () => invoke("files:import"),
  answerUploadConflict: (input) => invoke("uploads:answer", input),
  onUploadConflict: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on("jellyree:upload-conflict", listener);
    return () =>
      ipcRenderer.removeListener("jellyree:upload-conflict", listener);
  },
  folders: () => invoke("folders:list"),
  createFolder: (name, parent) => invoke("folders:create", name, parent),
  updateFolder: (id, patch) => invoke("folders:update", id, patch),
  deleteFolder: (id) => invoke("folders:delete", id),
  stats: () => invoke("stats"),
  onProgress: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on("jellyree:progress", listener);
    return () => ipcRenderer.removeListener("jellyree:progress", listener);
  },
});
