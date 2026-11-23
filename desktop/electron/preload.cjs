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
    clear: () => invoke("settings:clear"),
  },
  list: (input) => invoke("files:list", input),
  update: (ids, patch) => invoke("files:update", ids, patch),
  remove: (ids) => invoke("files:delete", ids),
  url: (id) => invoke("files:url", id),
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
