import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

export const root = fileURLToPath(new URL('.', import.meta.url));
export const assets = ['manifest.json', 'background.js', 'bridge.js', 'rules.js', 'rules-isolated.js', 'page-interceptor.js', 'recording-indicator.js', 'options.html', 'options.css', 'options-utils.js', 'options.js', 'icons', 'LICENSE', 'README.md', 'CHANGELOG.md'];
export function runNpm(args) {
  const cli = process.env.npm_execpath || path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
  if (!fs.existsSync(cli)) throw new Error('Run this command through npm so npm_execpath is available.');
  execFileSync(process.execPath, [cli, ...args], { cwd: root, stdio: 'inherit' });
}
export function powershell(script) {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference = 'Stop'; ${script}`], { cwd: root, encoding: 'utf8' });
}
export function releaseFiles() {
  const walk = name => fs.statSync(path.join(root, name)).isDirectory()
    ? fs.readdirSync(path.join(root, name)).flatMap(child => walk(`${name}/${child}`)) : [name];
  return assets.flatMap(walk);
}
