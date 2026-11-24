type ImageFile = { name: string; mime_type: string };
export function isHeicFile(file: ImageFile | null | undefined): boolean;
export const PXZ_MIME: "application/pxz";
export function isPxzFile(file: ImageFile | null | undefined): boolean;
export function isImageFile(file: ImageFile | null | undefined): boolean;
export function imageMimeType(file: ImageFile): string;
export function imageSaveFormat(file: ImageFile): {
  format: "png" | "jpeg" | "webp";
  convertsToPng: boolean;
};
export const IMAGE_EDIT_MAX_BYTES: number;
export const IMAGE_EXPORT_MAX_PIXELS: number;
export function matchesEncodedImage(
  data: Uint8Array,
  format: "png" | "jpeg" | "webp",
): boolean;
export const HEIC_MAX_PIXELS: number;
export function validateHeicDimensions(width: number, height: number): void;
