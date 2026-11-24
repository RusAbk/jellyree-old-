# HEIC/HEIF decoder

HEIC/HEIF support uses the prebuilt WebAssembly decoder from **libheif-js 1.23.5**.
The decoder and its embedded binary are bundled locally, loaded in a dedicated
image worker and used without a remote service.

- JavaScript wrapper and prebuilt distribution: https://github.com/catdad-experiments/libheif-js
- libheif sources: https://github.com/strukturag/libheif
- Build instructions: https://github.com/catdad-experiments/libheif-js/tree/master/scripts
- libheif-js and embedded decoder license notices: `libheif-js/LICENSE` next to this file.

The exact package version and integrity are recorded in `desktop/package-lock.json`.
