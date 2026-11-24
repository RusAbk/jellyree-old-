export const PXZ_LIMIT: number;
export type ReadPxzEntry = (
  name: string,
  limit?: number,
) => Promise<Uint8Array<ArrayBuffer> | undefined>;
export class PxzRangeReader {
  constructor(
    size: number,
    readRange: (offset: number, length: number) => Promise<Uint8Array>,
  );
}
export function readPxz<T>(
  source: Uint8Array | PxzRangeReader,
  inspect: (read: ReadPxzEntry) => Promise<T>,
  signal?: AbortSignal,
): Promise<T>;
