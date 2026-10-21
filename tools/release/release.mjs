/**
 * Publishes the checked-out commit as the GitHub Release installed copies
 * update to: tag v<manifest version>, one asset holding what Chrome loads.
 *
 *   node tools/release/release.mjs            build and publish
 *   node tools/release/release.mjs --dry-run  build the zip only
 *
 * Needs a clean, pushed working tree, a version not released before, and
 * `gh` signed in.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UPDATE } from '../../src/lib/const.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
/** What Chrome loads plus the updater; tests, tools and docs stay out. */
const SHIPPED = ['manifest.json', 'src', 'icons', 'updater', 'LICENSE', 'README.md', 'README.vi.md'];

const dryRun = process.argv.includes('--dry-run');
const run = (cmd, args) => execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8' }).trim();
const fail = (message) => {
    console.error(`release: ${message}`);
    process.exit(1);
};

const { version } = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
const tag = `v${version}`;
const sha = run('git', ['rev-parse', 'HEAD']);

// The zip is built from HEAD, so anything uncommitted would silently be left out.
if (run('git', ['status', '--porcelain'])) {
    if (!dryRun) fail('commit or stash your changes first');
    console.warn('release: uncommitted changes are not in the zip');
}

if (!dryRun) {
    if (run('git', ['ls-remote', '--tags', 'origin', `refs/tags/${tag}`])) {
        fail(`${tag} is already released — raise "version" in manifest.json`);
    }
    if (!run('git', ['branch', '-r', '--contains', sha])) fail('push this commit first');
}

const zip = join(mkdtempSync(join(tmpdir(), 'copydocext-release-')), UPDATE.ASSET);
run('git', ['archive', '--format=zip', '-o', zip, 'HEAD', ...SHIPPED]);
console.log(`${zip} (${Math.round(statSync(zip).size / 1024)} KB, ${tag} at ${sha.slice(0, 7)})`);

if (dryRun) process.exit(0);

run('gh', ['release', 'create', tag, zip, '--target', sha, '--title', tag, '--generate-notes']);
console.log(`Released ${tag}. Installed copies see it within a few hours.`);
