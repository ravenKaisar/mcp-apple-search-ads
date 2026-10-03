// Marks the compiled CLI entrypoint as executable so it can be used as an npm "bin".
import { chmodSync, existsSync } from 'node:fs';

const entry = new URL('../dist/index.js', import.meta.url);
if (existsSync(entry)) {
  chmodSync(entry, 0o755);
}
