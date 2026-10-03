/* eslint-disable no-console -- build-time CLI check */
// Fails the image build if production dependencies contain native code.
//
// The Dockerfile builds once on the build machine's platform and copies node_modules into every target
// platform (amd64 + arm64). That is only correct while all production dependencies are pure JavaScript;
// a native addon (.node file / node-gyp build) compiled for the build platform would crash on the other.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2] ?? 'node_modules';
if (!existsSync(root)) {
  console.error(`check-pure-js: ${root} does not exist`);
  process.exit(1);
}

const offenders = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      walk(path);
    } else if (entry.name.endsWith('.node') || entry.name === 'binding.gyp') {
      offenders.push(path);
    } else if (entry.name === 'package.json') {
      try {
        const pkg = JSON.parse(readFileSync(path, 'utf8'));
        if (pkg.gypfile === true) offenders.push(`${path} (gypfile: true)`);
      } catch {
        // Not every package.json under node_modules is valid JSON (fixtures); ignore those.
      }
    }
  }
};
walk(root);

if (offenders.length > 0) {
  console.error('check-pure-js: native code found in production dependencies:');
  for (const offender of offenders) console.error(`  ${offender}`);
  console.error(
    'The cross-platform Docker build copies node_modules between architectures; build per platform instead.',
  );
  process.exit(1);
}
console.log(`check-pure-js: ${root} is pure JavaScript`);
