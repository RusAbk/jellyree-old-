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
export type Adjustments = {
  brightness?: number;
  contrast?: number;
  saturation?: number;
  rotate?: number;
};
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
};
export type Stats = {
  files: number;
  bytes: number;
  trashed: number;
  tags: string[];
};
export type Progress = {
  kind: "upload" | "download" | "import";
  name?: string;
  done: number;
  total?: number;
  loaded?: number;
  totalBytes?: number;
  failures?: number;
};
export type UploadResult = {
  done: number;
  failures: { name: string; message: string }[];
};
export interface Jellyree {
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
  share(id: string): Promise<{ expiresIn: number }>;
  download(ids: string[]): Promise<{ done: number }>;
  pickUpload(folderId: string | null, folders: boolean): Promise<UploadResult>;
  dropUpload(files: File[], folderId: string | null): Promise<UploadResult>;
  importBucket(): Promise<{ scanned: number }>;
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
