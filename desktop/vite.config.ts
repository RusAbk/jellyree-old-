import { defineConfig, normalizePath } from "vite";
import vue from "@vitejs/plugin-vue";
import { viteStaticCopy } from "vite-plugin-static-copy";
import { fileURLToPath } from "node:url";
export default defineConfig(({ mode }) => ({
  build:
    mode === "mobile"
      ? {
          rollupOptions: {
            input: fileURLToPath(new URL("./mobile.html", import.meta.url)),
          },
        }
      : undefined,
  plugins: [
    vue(),
    viteStaticCopy({
      targets: [
        ...["cmaps", "standard_fonts", "wasm"].map((name) => ({
          src: normalizePath(
            fileURLToPath(
              new URL(`./node_modules/pdfjs-dist/${name}`, import.meta.url),
            ),
          ),
          dest: `pdfjs/${name}`,
          rename: { stripBase: true as const },
        })),
        {
          src: normalizePath(
            fileURLToPath(
              new URL(
                "./node_modules/libheif-js/libheif-wasm/LICENSE",
                import.meta.url,
              ),
            ),
          ),
          dest: "licenses/libheif-js",
          rename: { stripBase: true as const },
        },
        {
          src: normalizePath(
            fileURLToPath(new URL("./THIRD_PARTY_NOTICES.md", import.meta.url)),
          ),
          dest: "licenses",
          rename: { stripBase: true as const },
        },
      ],
    }),
  ],
  worker: { format: "es" },
  // Discover the lazy worker dependency before opening the app, avoiding a dev reload on first HEIC.
  optimizeDeps: { include: ["libheif-js/libheif-wasm/libheif-bundle.mjs"] },
  base: "./",
  server: { host: "127.0.0.1", port: 5174, strictPort: true },
}));
