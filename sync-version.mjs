import fs from "node:fs";

const packagePath = new URL("./package.json", import.meta.url);
const manifestPath = new URL("./manifest.json", import.meta.url);
const packageData = JSON.parse(fs.readFileSync(packagePath, "utf8"));
const version = packageData.version;

if (!/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error(`Invalid package version: ${version}`);
}

const lockPath = new URL('./package-lock.json', import.meta.url);
const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
if (lock.version !== version || lock.packages[''].version !== version) {
  lock.version = version;
  lock.packages[''].version = version;
  fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
}

const manifest = fs.readFileSync(manifestPath, "utf8");
if (!/("version"\s*:\s*)"[^"]+"/.test(manifest)) {
  throw new Error("Manifest version field not found");
}
const updatedManifest = manifest.replace(/("version"\s*:\s*)"[^"]+"/, `$1"${version}"`);

if (updatedManifest !== manifest) fs.writeFileSync(manifestPath, updatedManifest);
console.log(`Synced manifest version to ${version}`);
