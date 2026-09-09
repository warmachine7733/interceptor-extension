import fs from "node:fs";
import { execFileSync } from "node:child_process";

const nextVersion = process.argv[2];
const extraSummary = process.argv.slice(3).join(" ").trim();
const semverPattern = /^\d+\.\d+\.\d+$/;

if (!semverPattern.test(nextVersion || "")) {
  throw new Error("Usage: npm run bump -- <version> [summary]");
}

const packagePath = new URL("./package.json", import.meta.url);
const changelogPath = new URL("./CHANGELOG.md", import.meta.url);
const packageData = JSON.parse(fs.readFileSync(packagePath, "utf8"));
const currentVersion = packageData.version;
const changelog = fs.readFileSync(changelogPath, "utf8");
const hasChangelogEntry = new RegExp(`^## ${nextVersion.replaceAll(".", "\\.")}\\s*$`, "m").test(changelog);

if (nextVersion === currentVersion && hasChangelogEntry) {
  execFileSync("npm", ["run", "prebuild"], { stdio: "inherit" });
  console.log(`${nextVersion} is already prepared; package.json, manifest.json, and CHANGELOG.md are up to date.`);
  process.exit(0);
}

const gitSubjects = (() => {
  try {
    const tag = `v${currentVersion}`;
    const range = execFileSync("git", ["rev-parse", "--verify", `${tag}^{commit}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()
      ? [`${tag}..HEAD`]
      : ["-n", "20"];
    return execFileSync("git", ["log", ...range, "--pretty=%s"], { encoding: "utf8" })
      .split("\n")
      .map((subject) => subject.trim())
      .filter((subject) => subject && !/^bump version|^release /i.test(subject));
  } catch {
    return [];
  }
})();

const summaries = [...new Set([extraSummary, ...gitSubjects].filter(Boolean))].slice(0, 12);
const entry = `## ${nextVersion}\n${(summaries.length ? summaries : ["Review the changes included in this release."]).map((summary) => `- ${summary}`).join("\n")}\n\n`;
if (hasChangelogEntry) {
  throw new Error(`CHANGELOG.md already contains ${nextVersion}`);
}

packageData.version = nextVersion;
fs.writeFileSync(packagePath, `${JSON.stringify(packageData, null, 2)}\n`);
fs.writeFileSync(changelogPath, changelog.replace(/^# Release Log\s*\n\s*/, (heading) => `${heading}\n${entry}`));
execFileSync("npm", ["run", "prebuild"], { stdio: "inherit" });
console.log(`Bumped ${currentVersion} to ${nextVersion} and updated CHANGELOG.md.`);
