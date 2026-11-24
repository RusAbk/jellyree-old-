import { spawnSync } from "node:child_process";
import { copyFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { journalSchema } from "../../desktop/electron/catalog-journal.mjs";

const desktop = new URL("../../desktop/", import.meta.url);
const output = new URL("../assets/ui/", import.meta.url);
const vite = new URL("node_modules/vite/bin/vite.js", desktop);
const result = spawnSync(
  process.execPath,
  [
    fileURLToPath(vite),
    "build",
    "--mode",
    "mobile",
    "--outDir",
    fileURLToPath(output),
    "--emptyOutDir",
  ],
  { cwd: fileURLToPath(desktop), stdio: "inherit" },
);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
copyFileSync(
  new URL("electron/schema.sql", desktop),
  new URL("jr-schema.sql", output),
);
writeFileSync(
  new URL("jr-journal.json", output),
  JSON.stringify(journalSchema),
);
