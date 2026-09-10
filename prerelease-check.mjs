import fs from "node:fs";
import { execFileSync } from "node:child_process";

console.log("Running pre-release checks...\n");

// 1. Check version sync
const packageData = JSON.parse(fs.readFileSync(new URL("./package.json", import.meta.url), "utf8"));
const manifestData = JSON.parse(fs.readFileSync(new URL("./manifest.json", import.meta.url), "utf8"));
const changelog = fs.readFileSync(new URL("./CHANGELOG.md", import.meta.url), "utf8");

const version = packageData.version;
console.log(`Checking version: ${version}`);

if (manifestData.version !== version) {
  throw new Error(`Version mismatch: package.json is ${version} but manifest.json is ${manifestData.version}`);
}

const changelogPattern = new RegExp(`^## ${version.replaceAll(".", "\\.")}\\s*$`, "m");
if (!changelogPattern.test(changelog)) {
  throw new Error(`CHANGELOG.md is missing an entry for version ${version}`);
}
console.log("✓ Versions in package.json, manifest.json, and CHANGELOG.md are synchronized.");

// 2. Run test suite
console.log("\nRunning test suite...");
execFileSync("npm", ["test"], { stdio: "inherit" });
console.log("✓ All tests passed.");

// 3. Build bundle
console.log("\nBuilding release bundle...");
execFileSync("npm", ["run", "build"], { stdio: "inherit" });
console.log("✓ Build completed.");

// 4. Verify zip file contents
const distZipPath = new URL("./dist/local-api-mock.zip", import.meta.url);
if (!fs.existsSync(distZipPath)) {
  throw new Error("dist/local-api-mock.zip was not created.");
}

const requiredFiles = [
  "manifest.json",
  "background.js",
  "bridge.js",
  "rules.js",
  "page-interceptor.js",
  "options.html",
  "options.css",
  "options-utils.js",
  "options.js",
  "LICENSE",
  "README.md",
  "CHANGELOG.md"
];

const zipListing = execFileSync("unzip", ["-l", "dist/local-api-mock.zip"], { encoding: "utf8" });
for (const file of requiredFiles) {
  if (!zipListing.includes(file)) {
    throw new Error(`Release bundle is missing required file: ${file}`);
  }
}
console.log("✓ Release zip verified with all required assets.");

// 5. Check git status
try {
  const gitStatus = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim();
  if (gitStatus) {
    console.warn("\n⚠️  Warning: Git working directory has uncommitted changes:\n" + gitStatus);
  } else {
    console.log("✓ Git working tree is clean.");
  }
} catch {
  // Git check is best-effort if git is not initialized
}

console.log(`\n🎉 Pre-release checks passed successfully for v${version}!`);
