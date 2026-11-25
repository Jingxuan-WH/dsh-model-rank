import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
for (const file of readdirSync(new URL('.', import.meta.url)).filter((f) => /^validate-.*\.mjs$/.test(f)).sort()) {
  const result = spawnSync(process.execPath, [`scripts/${file}`], { cwd: root, stdio: 'inherit', timeout: 120000 });
  if (result.error) console.error(result.error.message);
  if (result.status !== 0) process.exit(result.status || 1);
}
