#!/usr/bin/env node
/**
 * check-version-sync.mjs — invoked by `npm publish` via the `prepublishOnly`
 * hook. Asserts that the version in `packages/core/package.json` matches the
 * latest header in the workspace-root `CHANGELOG.md`. Catches the common
 * release-mistake of bumping one without bumping the other.
 *
 * Exit code: 0 on match, 1 on mismatch (publish aborts).
 *
 * Pure stdlib — no Node deps so this runs fast at publish time.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf-8'));
const CHANGELOG = readFileSync(join(HERE, '..', '..', '..', 'CHANGELOG.md'), 'utf-8');

const pkgVersion = PKG.version;
// Match the first "## [VERSION]" header that isn't "[Unreleased]".
const m = CHANGELOG.match(/^##\s+\[(\d+\.\d+\.\d+(?:-[\w.]+)?)\]/m);
if (!m) {
  console.error('check-version-sync: no versioned ## [X.Y.Z] header found in CHANGELOG.md');
  process.exit(1);
}
const changelogVersion = m[1];

if (pkgVersion !== changelogVersion) {
  console.error(
    `check-version-sync: MISMATCH\n` +
    `  packages/core/package.json: ${pkgVersion}\n` +
    `  CHANGELOG.md latest entry:  ${changelogVersion}\n` +
    `  Bump one to match, or add a new CHANGELOG entry for ${pkgVersion}.`,
  );
  process.exit(1);
}

console.log(`check-version-sync: ${pkgVersion} matches CHANGELOG.md ✓`);
