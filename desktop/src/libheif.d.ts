declare module "libheif-js/libheif-wasm/libheif-bundle.mjs" {
  export interface HeifImage {
    get_width(): number;
    get_height(): number;
    is_primary(): boolean;
    display(data: ImageData, callback: (data: ImageData | null) => void): void;
    free(): void;
  }
  export interface Libheif {
    HeifDecoder: new () => {
      decoder: unknown;
      decode(data: Uint8Array): HeifImage[];
    };
    heif_context_free(context: unknown): void;
  }
  export default function createLibheif(): Libheif | Promise<Libheif>;
}
