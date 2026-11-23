import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const directory = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const platforms = {
  linux: "linux",
  win: "win",
  windows: "win",
  win32: "win",
  mac: "mac",
  macos: "mac",
  darwin: "mac",
};

export const help = `Сборка Jellyree Desktop

  node desktop/scripts/build.mjs [linux|win|mac] [опции]

Без платформы собирается установщик для текущей ОС и архитектуры.

  --arch x64|arm64|universal   Архитектура (universal — только macOS)
  --dir                      Распакованное приложение вместо установщика
  --dry-run                  Показать команды без запуска сборки
  --help                     Эта справка

Результат: desktop/release/. Публикация отключена.
Для macOS необходим Mac. Для Windows предпочтительна сборка на Windows;
кросс-сборка Windows на Linux/macOS требует окружения electron-builder с Wine.
Все платформы можно собрать через GitHub Actions → Build desktop installers.
`;

export function buildPlan(
  args,
  host = { platform: process.platform, arch: process.arch },
) {
  let platform = platforms[host.platform],
    arch = host.arch,
    explicitPlatform = false;
  let unpacked = false,
    dryRun = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") return { help: true };
    if (arg === "--dir") unpacked = true;
    else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--arch" || arg.startsWith("--arch=")) {
      arch = arg === "--arch" ? args[++index] : arg.slice(7);
    } else if (platforms[arg] && !explicitPlatform) {
      platform = platforms[arg];
      explicitPlatform = true;
    } else throw new Error(`Неизвестный аргумент: ${arg}. Используйте --help.`);
  }
  if (!platform) throw new Error("Укажите платформу: linux, win или mac.");
  if (!["x64", "arm64", "universal"].includes(arch))
    throw new Error("Архитектура должна быть x64, arm64 или universal.");
  if (arch === "universal" && platform !== "mac")
    throw new Error("Архитектура universal доступна только для macOS.");
  if (platform === "mac" && host.platform !== "darwin" && !dryRun)
    throw new Error(
      "DMG необходимо собирать на macOS. Используйте Mac или workflow Build desktop installers в GitHub Actions.",
    );
  return {
    platform,
    arch,
    dryRun,
    commands: [
      { tool: "vue-tsc", args: ["--noEmit"] },
      { tool: "vite", args: ["build"] },
      {
        tool: "electron-builder",
        args: [
          `--${platform}`,
          `--${arch}`,
          ...(unpacked ? ["--dir"] : []),
          "--publish",
          "never",
        ],
      },
    ],
  };
}

function binary(tool) {
  try {
    const manifestPath = require.resolve(`${tool}/package.json`);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const entry =
      typeof manifest.bin === "string" ? manifest.bin : manifest.bin[tool];
    return path.resolve(path.dirname(manifestPath), entry);
  } catch {
    throw new Error(`Не найден ${tool}. Выполните npm ci в desktop/.`);
  }
}

function run(command) {
  // Run the CLI's JavaScript entry point directly: works without shell/.cmd on Windows.
  const entry = binary(command.tool);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...command.args], {
      cwd: directory,
      stdio: "inherit",
      env: process.env,
    });
    const stop = (signal) => child.kill(signal);
    const onInterrupt = () => stop("SIGINT"),
      onTerminate = () => stop("SIGTERM");
    process.once("SIGINT", onInterrupt);
    process.once("SIGTERM", onTerminate);
    const cleanup = () => {
      process.off("SIGINT", onInterrupt);
      process.off("SIGTERM", onTerminate);
    };
    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("exit", (code, signal) => {
      cleanup();
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `${command.tool}: ${signal ? `сигнал ${signal}` : `код выхода ${code}`}.`,
          ),
        );
    });
  });
}

async function main() {
  const plan = buildPlan(process.argv.slice(2));
  if (plan.help) {
    console.log(help);
    return;
  }
  console.log(
    `Jellyree: ${plan.platform} / ${plan.arch}${plan.dryRun ? " (без выполнения)" : ""}`,
  );
  for (const command of plan.commands) {
    console.log(`\n> ${command.tool} ${command.args.join(" ")}`);
    if (!plan.dryRun) await run(command);
  }
  if (!plan.dryRun) console.log(`\nГотово: ${path.join(directory, "release")}`);
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  main().catch((error) => {
    console.error(`\nСборка остановлена: ${error.message}`);
    process.exitCode = 1;
  });
}
