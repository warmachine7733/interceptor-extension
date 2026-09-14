import fs from "node:fs";

// Chromium deduplicates content-script file paths across worlds. Give the
// isolated bridge its own resource, generated from the unchanged matcher.
const rules = fs.readFileSync(new URL("./rules.js", import.meta.url), "utf8");
fs.writeFileSync(new URL("./rules-isolated.js", import.meta.url), rules);
