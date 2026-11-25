import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(
  new URL("../../desktop/package.json", import.meta.url),
);
const { chromium, devices } = require("@playwright/test");
const assets = fileURLToPath(new URL("../assets/ui/", import.meta.url));
let image = await readFile(
  new URL("../../desktop/test/fixtures/editor.png", import.meta.url),
);
const files = [
  {
    id: "first",
    name: "Lake.png",
    object_key: "lake",
    created_at: "2026-11-25T01:00:00.000Z",
  },
  {
    id: "second",
    name: "Forest.png",
    object_key: "forest",
    created_at: "2021-06-01T01:00:00.000Z",
  },
].map((file) => ({
  ...file,
  updated_at: file.created_at,
  size_bytes: image.length,
  folder_id: null,
  trashed_at: null,
  mime_type: "image/png",
  adjustments: {},
  tags: [],
  favorite: false,
}));
const preferences = {};
const profiles = [
  {
    id: "personal",
    name: "Personal",
    bucket: "fixture",
    prefix: "photos",
    persisted: true,
  },
  {
    id: "work",
    name: "Work Library",
    bucket: "work-bucket",
    prefix: "shared",
    persisted: true,
  },
];
let activeProfile = profiles[0];
const settings = () => ({
  ...activeProfile,
  activeProfileId: activeProfile.id,
  configured: true,
  profiles,
});
const json = (response, value) => {
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify({ ok: true, value }));
};
const binary = (response, buffer, type) => {
  response.setHeader("Content-Type", type);
  response.end(buffer);
};
const fileFor = (id) => files.find((file) => file.id === id);
const mediaFiles = (kind) =>
  files.filter((file) =>
    kind === "photo"
      ? file.mime_type.startsWith("image/")
      : kind === "video"
        ? file.mime_type.startsWith("video/")
        : true,
  );
const root = "/fixture/";
const rpcCalls = [];
const timelineKinds = [];
const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  const route = url.pathname.slice(root.length);
  try {
    if (!url.pathname.startsWith(root)) {
      response.writeHead(404).end();
      return;
    }
    if (route === "_events") {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write(": fixture\n\n");
      return;
    }
    if (route.startsWith("_media/")) {
      binary(response, image, "image/png");
      return;
    }
    if (!route.startsWith("_rpc/")) {
      const name = route || "mobile.html";
      const type =
        {
          ".js": "text/javascript",
          ".mjs": "text/javascript",
          ".css": "text/css",
          ".html": "text/html",
          ".woff2": "font/woff2",
          ".wasm": "application/wasm",
        }[path.extname(name)] || "application/octet-stream";
      const target = path.resolve(assets, name);
      assert.ok(target.startsWith(assets));
      binary(response, await readFile(target), type);
      return;
    }
    const data = [];
    for await (const chunk of request) data.push(chunk);
    const body = Buffer.concat(data);
    const args = JSON.parse(
      request.headers["x-jellyree-args"]
        ? Buffer.from(
            request.headers["x-jellyree-args"],
            "base64url",
          ).toString()
        : body.toString(),
    );
    const method = route.slice(5);
    rpcCalls.push(method);
    const file = fileFor(args[0]);
    switch (method) {
      case "preferences":
        return json(response, preferences);
      case "setPreferences":
        Object.assign(preferences, args[0]);
        return json(response, null);
      case "settings.get":
        return json(response, settings());
      case "settings.select":
        activeProfile = profiles.find((profile) => profile.id === args[0]);
        return json(response, settings());
      case "list":
        return json(response, {
          items:
            activeProfile.id === "work"
              ? [{ ...files[0], name: "Work-only.png" }]
              : mediaFiles(args[0].mediaKind).filter(
                  (row) => args[0].section !== "favorites" || row.favorite,
                ),
          hasMore: false,
          page: 1,
        });
      case "folders":
        return json(response, []);
      case "stats":
        return json(response, {
          files: 2,
          bytes: image.length * 2,
          trashed: 0,
          tags: ["summer", "lake"],
        });
      case "timelineBounds": {
        timelineKinds.push(args[0]);
        const dates = mediaFiles(args[0])
          .map((file) => file.created_at)
          .sort();
        return json(response, {
          newest: dates.at(-1) ?? null,
          oldest: dates[0] ?? null,
        });
      }
      case "thumb.get":
        return json(response, { epoch: 0, entry: null });
      case "thumb.dimensions":
        return json(
          response,
          args[0].map(() => null),
        );
      case "thumb.source":
        return json(
          response,
          new URL(`_media/${args[0].id}`, `${url.origin}${root}`).pathname,
        );
      case "url":
        return json(response, `${root}_media/${file.id}`);
      case "imageSource":
        return binary(response, image, "image/png");
      case "saveEditedImage":
        assert.equal(args[1], file.object_key);
        assert.ok(body.subarray(0, 8).equals(image.subarray(0, 8)));
        image = body;
        file.object_key += "-edited";
        file.size_bytes = image.length;
        file.adjustments = {};
        return json(response, { file });
      case "update":
        for (const id of args[0]) Object.assign(fileFor(id), args[1]);
        return json(response, null);
      default:
        return json(response, null);
    }
  } catch (error) {
    console.error(error);
    response.writeHead(500).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome",
    headless: true,
  });
  const page = await browser.newPage(devices["iPhone 13"]);
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const { port } = server.address();
  await page.goto(`http://127.0.0.1:${port}${root}`);
  await page.locator(".file-card").first().waitFor();
  assert.ok(await page.locator(".mobile-tab-bar").isVisible());
  assert.equal(await page.locator(".sidebar").isVisible(), false);
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth),
    390,
  );
  await page.getByRole("button", { name: "Open menu" }).tap();
  await page.locator(".sidebar").waitFor();
  await page
    .getByRole("button", { name: "Close menu" })
    .tap({ position: { x: 367, y: 340 } });
  await page.locator(".sidebar").waitFor({ state: "hidden" });

  const connection = page.getByRole("button", {
    name: "Switch connection",
    exact: true,
  });
  const picker = page.getByRole("dialog", { name: "Connections", exact: true });
  await connection.tap();
  await picker
    .locator('[aria-current="true"]')
    .getByText("Personal", { exact: true })
    .waitFor();
  const popup = await picker.boundingBox();
  assert.ok(popup.x >= 0 && popup.x + popup.width <= 390);
  await page.evaluate(() => window.jellyreeMobileBack());
  await picker.waitFor({ state: "hidden" });
  await connection.tap();
  await picker
    .getByRole("button", {
      name: "Open connection “Work Library”",
      exact: true,
    })
    .tap();
  await page.getByText("Work-only.png", { exact: true }).waitFor();
  assert.equal(await page.getByText("Forest.png", { exact: true }).count(), 0);
  await connection.tap();
  await picker
    .locator('[aria-current="true"]')
    .getByText("Work Library", { exact: true })
    .waitFor();
  await picker
    .getByRole("button", { name: "Open connection “Personal”", exact: true })
    .tap();
  await page.getByText("Forest.png", { exact: true }).waitFor();

  const firstCard = page.locator('.file-card[data-file-id="first"]');
  await firstCard.dispatchEvent("pointerdown", {
    pointerType: "touch",
    isPrimary: true,
    clientX: 90,
    clientY: 240,
  });
  await page.getByRole("menu").waitFor();
  await firstCard.dispatchEvent("pointerup", {
    pointerType: "touch",
    isPrimary: true,
  });
  await page.evaluate(() => window.jellyreeMobileBack());
  await page.getByRole("menu").waitFor({ state: "hidden" });
  await firstCard.tap();
  const viewer = page.locator(".preview-overlay");
  await viewer.locator(".photo-frame img").waitFor();
  const stage = viewer.locator(".photo-viewport");
  await stage.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const makeTouch = (x) =>
      new Touch({
        identifier: 1,
        target: element,
        clientX: x,
        clientY: bounds.top + 80,
      });
    const start = makeTouch(bounds.left + 170);
    const finish = makeTouch(bounds.left + 45);
    element.dispatchEvent(
      new TouchEvent("touchstart", {
        touches: [start],
        changedTouches: [start],
        bubbles: true,
      }),
    );
    element.dispatchEvent(
      new TouchEvent("touchend", {
        touches: [],
        changedTouches: [finish],
        bubbles: true,
      }),
    );
  });
  await viewer.locator(".preview-header").getByText("Forest.png").waitFor();
  await viewer.getByRole("button", { name: "Previous file" }).tap();
  await viewer.locator(".preview-header").getByText("Lake.png").waitFor();
  await viewer.getByRole("button", { name: "Tags", exact: true }).tap();
  const tags = viewer.locator(".preview-tags");
  await tags
    .getByRole("group", { name: "Existing tags" })
    .getByRole("button", { name: "lake" })
    .tap();
  await tags.getByRole("button", { name: "Remove tag “lake”" }).waitFor();
  await tags.getByRole("button", { name: "Close", exact: true }).tap();
  await viewer.locator(".preview-header .button").tap();
  const editor = page.locator(".photo-editor");
  await editor.locator("canvas").waitFor();
  await editor.getByText("Result:", { exact: false }).waitFor();
  await editor
    .getByRole("button", { name: "Classic auto", exact: false })
    .tap();
  await editor.getByRole("button", { name: "Save to file", exact: true }).tap();
  await editor.getByText("Image saved. Adjustments reset.").waitFor();
  assert.ok(rpcCalls.includes("saveEditedImage"));
  assert.equal(fileFor("first").object_key, "lake-edited");
  await editor.locator(".photo-editor-header .icon-button").last().tap();
  await viewer
    .getByRole("button", { name: "Close preview", exact: true })
    .tap();
  files.push({
    ...files[0],
    id: "clip",
    name: "Clip.mp4",
    mime_type: "video/mp4",
    object_key: "clip",
    created_at: "2023-02-02T12:00:00.000Z",
  });
  await page
    .locator(".mobile-tab-bar")
    .getByRole("button", { name: "Media timeline" })
    .tap();
  await page
    .getByRole("complementary", { name: "Timeline" })
    .getByRole("slider")
    .waitFor();
  const mediaFilters = page.getByRole("group", { name: "Media type" });
  const videoFilter = mediaFilters.getByRole("button", {
    name: "Videos",
    exact: true,
  });
  await videoFilter.tap();
  await page.locator('.media-card[data-file-id="clip"]').waitFor();
  const scale = page.getByRole("complementary", { name: "Timeline" });
  await scale
    .getByRole("button", { name: "Go to 2023", exact: true })
    .waitFor();
  assert.equal(await page.locator(".media-card").count(), 1);
  assert.ok(timelineKinds.includes("video"));
  assert.equal(await scale.locator(".year-mark").count(), 1);
  const filterBox = await mediaFilters.boundingBox();
  assert.ok(filterBox.x >= 0 && filterBox.x + filterBox.width <= 390);
  await page.getByRole("button", { name: "Open menu", exact: true }).tap();
  await page
    .getByRole("button", { name: "Photos and videos", exact: true })
    .tap();
  await mediaFilters.getByRole("button", { name: "Photos", exact: true }).tap();
  await page.locator('.file-card[data-file-id="first"]').waitFor();
  assert.equal(
    await page.locator('.file-card[data-file-id="clip"]').count(),
    0,
  );
  await page
    .locator(".mobile-tab-bar")
    .getByRole("button", { name: "Media timeline" })
    .tap();
  await page.locator('.media-card[data-file-id="clip"]').waitFor();
  assert.equal(await videoFilter.getAttribute("aria-pressed"), "true");
  assert.deepEqual(errors, []);
  await page.screenshot({
    path: path.join(os.tmpdir(), "jellyree-mobile-timeline.png"),
  });
  console.log(
    "PASS: bundled UI, mobile RPC, navigation, touch swipe, tags, photo replacement, and media filters",
  );
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
