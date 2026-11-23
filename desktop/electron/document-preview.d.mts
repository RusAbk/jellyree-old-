export type DocumentKind = "pdf" | "text" | "markdown";
export function documentKind(file: {
  name: string;
  mime_type: string;
}): DocumentKind | null;
export const documentLimits: Record<DocumentKind, number>;
