export type Connection = {
  accountId: string;
  databaseId: string;
  apiToken: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  prefix: string;
};
export type Settings = Partial<
  Omit<Connection, "apiToken" | "accessKeyId" | "secretAccessKey">
> & {
  configured: boolean;
  persisted: boolean;
  hasSecrets?: boolean;
  startupError?: string;
};
export type Folder = {
  id: string;
  name: string;
  parent_id: string | null;
  created_at: string;
};
export type Adjustments = Partial<
  import("../electron/image-adjustments.mjs").ImageAdjustments
>;
export type DriveFile = {
  id: string;
  folder_id: string | null;
  object_key: string;
  name: string;
  mime_type: string;
  size_bytes: number;
  favorite: boolean;
  trashed_at: string | null;
  tags: string[];
  adjustments: Adjustments;
  created_at: string;
  updated_at: string;
};
export type ListInput = {
  section: string;
  folderId?: string | null;
  search?: string;
  tag?: string;
  sort?: string;
  page?: number;
};
export type FilePatch = {
  name?: string;
  favorite?: boolean;
  trashed?: boolean;
  folderId?: string | null;
  tags?: string[];
  adjustments?: Adjustments;
  expectedObjectKey?: string;
};
export type Stats = {
  files: number;
  bytes: number;
  trashed: number;
  tags: string[];
};
export type ThumbnailRevision = {
  id: string;
  objectKey: string;
  sizeBytes: number;
  mimeType: string;
  adjustments: Adjustments;
};
export type ThumbnailEntry = {
  data: Uint8Array;
  width: number;
  height: number;
  duration: number;
};
export type ThumbnailStats = { count: number; bytes: number; maxBytes: number };
export type CapturedVideoFrame = { timestamp: number; data: Uint8Array };
export type Progress = {
  kind: "upload" | "download" | "import";
  jobId?: string;
  phase?: "queued" | "preparing" | "uploading";
  name?: string;
  done: number;
  total?: number;
  loaded?: number;
  totalBytes?: number;
  failures?: number;
  fileIndex?: number;
  fileState?: "uploading" | "uploaded" | "skipped" | "failed" | "canceled";
  sizeBytes?: number;
  targetPath?: string;
  message?: string;
};
export type UploadResult = {
  done: number;
  skipped?: number;
  canceled?: boolean;
  warnings?: string[];
  failures: { name: string; message: string }[];
};
export type UploadConflict = {
  jobId?: string;
  id: string;
  name: string;
  targetPath: string;
  suggestedName: string;
  remaining: number;
  total: number;
  incomingBytes: number;
  existing: { name: string; sizeBytes: number; updatedAt: string };
  existingCount: number;
};
export type UploadConflictAnswer = {
  id: string;
  action: "skip" | "rename" | "replace" | "cancel";
  applyToAll: boolean;
  name?: string;
};
export interface Jellyree {
  thumbnails: {
    get(
      revision: ThumbnailRevision,
    ): Promise<{ epoch: number; entry: ThumbnailEntry | null }>;
    put(
      revision: ThumbnailRevision,
      entry: ThumbnailEntry,
      epoch: number,
    ): Promise<boolean>;
    source(revision: ThumbnailRevision, requestId?: string): Promise<string>;
    stats(): Promise<ThumbnailStats>;
    clear(): Promise<ThumbnailStats>;
  };
  setLocale(value: "en" | "ru" | "es"): Promise<void>;
  settings: {
    get(): Promise<Settings>;
    test(input: Connection): Promise<{ ok: boolean }>;
    save(input: Connection): Promise<Settings>;
    clear(): Promise<Settings>;
  };
  list(input: ListInput): Promise<{
    items: DriveFile[];
    total: number;
    hasMore: boolean;
    page: number;
  }>;
  update(ids: string[], patch: FilePatch): Promise<void>;
  remove(ids: string[]): Promise<{ done: number }>;
  url(id: string): Promise<string>;
  imageSource(
    id: string,
    requestId?: string,
    pxz?: { objectKey: string; thumbnail: boolean },
  ): Promise<{ data: Uint8Array; mimeType: string }>;
  cancelPreview(requestId: string): Promise<void>;
  releaseMedia(url: string): Promise<boolean>;
  documentSource(
    id: string,
    expectedObjectKey: string,
  ): Promise<{ data: Uint8Array; kind: "pdf" | "text" | "markdown" }>;
  saveTextDocument(
    id: string,
    expectedObjectKey: string,
    data: Uint8Array,
  ): Promise<{ file: DriveFile; warning?: string }>;
  setDocumentDraft(owner: string, dirty: boolean): Promise<void>;
  videoSource(revision: ThumbnailRevision): Promise<string>;
  saveVideoFrame(
    id: string,
    expectedObjectKey: string,
    timestamp: number,
    data: Uint8Array,
  ): Promise<DriveFile>;
  downloadVideoFrame(
    id: string,
    expectedObjectKey: string,
    timestamp: number,
    data: Uint8Array,
  ): Promise<{ saved: boolean }>;
  exportImage(
    id: string,
    data: Uint8Array,
    format: "png" | "jpeg" | "webp",
  ): Promise<{ saved: boolean }>;
  share(id: string): Promise<{ expiresIn: number }>;
  download(ids: string[]): Promise<{ done: number }>;
  pickUpload(
    folderId: string | null,
    folders: boolean,
    jobId?: string,
  ): Promise<UploadResult>;
  dropUpload(
    files: File[],
    folderId: string | null,
    jobId?: string,
  ): Promise<UploadResult>;
  importBucket(): Promise<{ scanned: number }>;
  answerUploadConflict(input: UploadConflictAnswer): Promise<void>;
  onUploadConflict(callback: (conflict: UploadConflict) => void): () => void;
  folders(): Promise<Folder[]>;
  createFolder(name: string, parentId: string | null): Promise<Folder>;
  updateFolder(
    id: string,
    input: { name?: string; parentId?: string | null },
  ): Promise<void>;
  deleteFolder(id: string): Promise<void>;
  stats(): Promise<Stats>;
  onProgress(callback: (progress: Progress) => void): () => void;
}
declare global {
  interface Window {
    jellyree: Jellyree;
  }
}
