import createLibheif, {
  type Libheif,
  type HeifImage,
} from "libheif-js/libheif-wasm/libheif-bundle.mjs";
import { validateHeicDimensions } from "../electron/image-formats.mjs";
let loaded: Promise<Libheif> | undefined;
function libheif() {
  return (loaded ??= Promise.resolve()
    .then(() => createLibheif())
    .catch((error) => {
      loaded = undefined;
      throw error;
    }));
}
export async function decodeHeicImage(
  source: ArrayBuffer,
): Promise<ImageBitmap> {
  const library = await libheif(),
    decoder = new library.HeifDecoder();
  let images: HeifImage[] = [];
  try {
    images = decoder.decode(new Uint8Array(source));
    const image = images.find((frame) => frame.is_primary()) || images[0];
    if (!image) throw new Error("heic-decode-failed");
    const width = image.get_width(),
      height = image.get_height();
    // Validate dimensions before allocating a potentially large RGBA buffer.
    validateHeicDimensions(width, height);
    const pixels = await new Promise<ImageData>((resolve, reject) =>
      image.display(new ImageData(width, height), (data) =>
        data ? resolve(data) : reject(new Error("heic-decode-failed")),
      ),
    );
    return await createImageBitmap(pixels);
  } finally {
    for (const image of images) image.free();
    if (decoder.decoder) {
      library.heif_context_free(decoder.decoder);
      decoder.decoder = null;
    }
  }
}
