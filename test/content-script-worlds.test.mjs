import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
import { releaseFiles } from "../release-tools.mjs";

const read = file => fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

test("content-script dependencies survive Chromium's cross-world file deduplication", () => {
  const manifest = JSON.parse(read("manifest.json"));
  const loaded = new Set();
  const worlds = new Map();
  for (const entry of manifest.content_scripts) {
    const world = entry.world || "ISOLATED";
    if (!worlds.has(world)) worlds.set(world, vm.createContext({ window: {} }));
    const context = worlds.get(world);
    for (const file of entry.js) {
      if (loaded.has(file)) continue;
      loaded.add(file);
      if (["bridge.js", "page-interceptor.js"].includes(file)) {
        assert.equal(typeof context.window.ApiMockRules?.firstMatch, "function", `${file} needs its matcher in ${world}`);
      } else {
        vm.runInContext(read(file), context);
      }
    }
  }
});

test("isolated matcher resource is generated verbatim from the canonical matcher", () => {
  assert.equal(read("rules-isolated.js"), read("rules.js"));
  const build = JSON.parse(read("package.json")).scripts;
  assert.match(build.prebuild, /sync-rules\.mjs/);
  assert.ok(releaseFiles().includes('rules-isolated.js'));
});

test('release includes every manifest runtime resource and options dependency', () => {
  const manifest = JSON.parse(read('manifest.json'));
  const files = releaseFiles();
  const required = [manifest.background.service_worker, manifest.options_page, ...Object.values(manifest.icons), ...manifest.content_scripts.flatMap(entry => entry.js)];
  required.push(...Array.from(read(manifest.options_page).matchAll(/(?:src|href)="([^"#]+\.(?:js|css))"/g), match => match[1]));
  for (const file of required) assert.ok(files.includes(file), `Missing release asset: ${file}`);
  assert.equal(new Set(files).size, files.length);
});
