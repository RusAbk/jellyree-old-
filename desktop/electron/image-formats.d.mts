type ImageFile = { name: string; mime_type: string };
export function isHeicFile(file: ImageFile | null | undefined): boolean;
export function isImageFile(file: ImageFile | null | undefined): boolean;
export function imageMimeType(file: ImageFile): string;
export const HEIC_MAX_PIXELS: number;
export function validateHeicDimensions(width: number, height: number): void;
