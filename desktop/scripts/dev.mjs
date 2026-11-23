import { spawn } from "node:child_process";
import { createServer } from "vite";
import electron from "electron";
const server = await createServer();
await server.listen();
const child = spawn(electron, [...process.argv.slice(2), "."], {
  stdio: "inherit",
  env: { ...process.env, JELLYREE_DEV_URL: "http://127.0.0.1:5174" },
});
child.on("exit", async (code) => {
  await server.close();
  process.exit(code ?? 1);
});
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => child.kill(signal));
