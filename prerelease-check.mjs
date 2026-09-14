import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { root, runNpm, powershell, releaseFiles } from './release-tools.mjs';

const readJson = name => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
const version = readJson('package.json').version;
const lock = readJson('package-lock.json');
console.log(`Checking release v${version}...`);
if ([readJson('manifest.json').version, lock.version, lock.packages[''].version].some(value => value !== version)) {
  throw new Error('Package, manifest, and lockfile versions must match.');
}
if (!new RegExp(`^## ${version.replaceAll('.', '\\.')}\\s*$`, 'm').test(fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'))) {
  throw new Error(`CHANGELOG.md is missing version ${version}`);
}
runNpm(['test']);
runNpm(['run', 'build']);
const zip = path.join(root, 'dist/local-api-mock.zip');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
let entries;
if (process.platform === 'win32') {
  entries = JSON.parse(powershell(`
    Add-Type -AssemblyName System.IO.Compression.FileSystem;
    $archive = [System.IO.Compression.ZipFile]::OpenRead((Join-Path (Get-Location) 'dist/local-api-mock.zip'));
    try {
      $result = @($archive.Entries | Where-Object { $_.Name } | ForEach-Object {
        $stream = $_.Open(); $sha = [System.Security.Cryptography.SHA256]::Create();
        try { @{ name = $_.FullName.Replace('\\', '/'); hash = [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() } }
        finally { $stream.Dispose(); $sha.Dispose() }
      });
      ConvertTo-Json -InputObject $result -Compress;
    } finally { $archive.Dispose() }
  `));
} else {
  entries = execFileSync('unzip', ['-Z1', zip], { encoding: 'utf8' }).trim().split('\n').filter(name => !name.endsWith('/')).map(name => ({
    name, hash: hash(execFileSync('unzip', ['-p', zip, name]))
  }));
}
const expected = releaseFiles();
if (entries.length !== expected.length || new Set(entries.map(entry => entry.name)).size !== expected.length) {
  throw new Error('ZIP contains unexpected or duplicate files.');
}
for (const name of expected) {
  if (entries.find(entry => entry.name === name)?.hash !== hash(fs.readFileSync(path.join(root, name)))) {
    throw new Error(`ZIP asset is missing or differs from source: ${name}`);
  }
}
console.log(`Verified all ${expected.length} ZIP assets against source, including manifest v${version}.`);
const status = execFileSync('git', ['status', '--short'], { cwd: root, encoding: 'utf8' }).trim();
if (status) console.warn(`Working tree changes:\n${status}`);
console.log(`Pre-release checks passed for v${version}.`);
