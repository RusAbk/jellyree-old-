import { defineConfig, normalizePath } from "vite";
import vue from "@vitejs/plugin-vue";
import { viteStaticCopy } from "vite-plugin-static-copy";
import { fileURLToPath } from "node:url";
export default defineConfig({
  plugins: [
    vue(),
    viteStaticCopy({
      targets: ["cmaps", "standard_fonts", "wasm"].map((name) => ({
        src: normalizePath(
          fileURLToPath(
            new URL(`./node_modules/pdfjs-dist/${name}`, import.meta.url),
          ),
        ),
        dest: "pdfjs",
      })),
    }),
  ],
  base: "./",
  server: { host: "127.0.0.1", port: 5174, strictPort: true },
});
