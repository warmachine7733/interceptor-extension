import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { assets, root, powershell, releaseFiles } from './release-tools.mjs';

releaseFiles(); // Validate every input before touching the previous bundle.
const output = path.join(root, 'dist/local-api-mock.zip');
fs.mkdirSync(path.dirname(output), { recursive: true });
if (process.platform === 'win32') {
  powershell(`Compress-Archive -LiteralPath ${assets.map(name => `'${name}'`).join(',')} -DestinationPath 'dist/local-api-mock.zip' -Force`);
} else {
  // zip is provided by the standard release environment on macOS/Linux.
  fs.rmSync(output, { force: true });
  execFileSync('zip', ['-q', '-r', output, ...assets], { cwd: root, stdio: 'inherit' });
}
console.log(`Built ${output}`);
