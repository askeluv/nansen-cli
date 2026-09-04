/**
 * Update check — lightweight, non-blocking, zero-dependency.
 *
 * getUpdateNotification(currentVersion) — reads cached result, returns string or null
 * scheduleUpdateCheck()                — spawns detached background fetch if cache is stale
 */

import fs from 'fs';
import path from 'path';
import childProcess from 'child_process';
import { fileURLToPath } from 'url';
import { compareSemver } from './semver.js';

const __filename = fileURLToPath(import.meta.url);
const CONFIG_DIR = path.join(process.env.HOME || process.env.USERPROFILE || '', '.nansen');
const CACHE_FILE = path.join(CONFIG_DIR, 'update-check.json');
const STALE_MS = 24 * 60 * 60 * 1000; // 24 hours
const PACKAGE_NAME = 'nansen-cli';

/**
 * Compare two semver strings. Returns true if latest > current.
 * Exported so `nansen doctor` reports upgrade state with identical semantics.
 *
 * Delegates to the shared compareSemver (src/semver.js, also used by `nansen
 * changelog --since`) instead of hand-rolling its own parser. The previous
 * inline parser here had the same bug compareSemver used to have: a version
 * string with fewer than 3 components (e.g. a hand-edited or truncated cache
 * file) parsed its missing component as `undefined`, and `>` is always
 * `false` against `undefined` in both directions — so a partial version
 * always read as "not newer", never "newer". In practice both `latest` (from
 * the npm registry) and `current` (from this package's own version) are
 * always full x.y.z today, so this couldn't misfire yet — but it's the same
 * defect class, so it's fixed the same way rather than left as a landmine.
 */
export function isNewer(latest, current) {
  return compareSemver(latest, current) > 0;
}

const LAST_VERSION_FILE = path.join(CONFIG_DIR, 'last-version.json');

/**
 * After an update, show a one-time "what's new" notice on the first run.
 * Compares current version against the stored last-seen version.
 * Returns a notice string or null. Writes current version to disk.
 */
export function getUpgradeNotice(currentVersion) {
  try {
    if (process.env.NO_UPDATE_NOTIFIER || process.env.CI) return null;

    let previousVersion = null;
    if (fs.existsSync(LAST_VERSION_FILE)) {
      const raw = fs.readFileSync(LAST_VERSION_FILE, 'utf8');
      const data = JSON.parse(raw);
      previousVersion = data.version;
    }

    // Always update the stored version
    if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { mode: 0o700, recursive: true });
    fs.writeFileSync(LAST_VERSION_FILE, JSON.stringify({ version: currentVersion }));

    // If no previous version stored, this is a fresh install — no notice
    if (!previousVersion) return null;

    // If versions match, no update happened
    if (previousVersion === currentVersion) return null;

    // Version changed — show notice
    return `\n  ✨ Updated to ${currentVersion} (was ${previousVersion}). Run \`nansen changelog --since ${previousVersion}\` for details.\n`;
  } catch {
    return null;
  }
}

/**
 * Read the cached check result and return a notification string (or null).
 */
export function getUpdateNotification(currentVersion) {
  try {
    if (process.env.NO_UPDATE_NOTIFIER || process.env.CI) return null;
    if (!fs.existsSync(CACHE_FILE)) return null;

    const raw = fs.readFileSync(CACHE_FILE, 'utf8');
    const { latest } = JSON.parse(raw);
    if (!latest) return null;

    if (isNewer(latest, currentVersion)) {
      return `Update available: ${currentVersion} → ${latest}  (npm i -g ${PACKAGE_NAME})`;
    }
    return null;
  } catch {
    return null;
  }
}

const REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;

/**
 * Build the Node source run by the detached child. It fetches the latest
 * version and writes it to `file` atomically: the JSON is written to a
 * pid-scoped temp file, then renamed over the target. rename(2) is atomic on
 * POSIX, so a concurrent `nansen` reader always sees either the old file or the
 * fully-written new one — never a truncated/empty file.
 *
 * The registry URL is overridable via NANSEN_REGISTRY_URL purely as a test seam
 * (lets a test point the child at a local server); it defaults to npm.
 */
export function buildCheckScript(dir, file, url = process.env.NANSEN_REGISTRY_URL || REGISTRY_URL) {
  return `
    const url = ${JSON.stringify(url)};
    const http = require(url.startsWith('https:') ? 'https' : 'http');
    const fs = require('fs');
    const dir = ${JSON.stringify(dir)};
    const file = ${JSON.stringify(file)};
    const req = http.get(url, { timeout: 5000 }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          const { version } = JSON.parse(body);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { mode: 0o700, recursive: true });
          const tmp = file + '.' + process.pid + '.tmp';
          try {
            fs.writeFileSync(tmp, JSON.stringify({ latest: version, checkedAt: Date.now() }));
            fs.renameSync(tmp, file);
          } catch (e) {
            try { fs.unlinkSync(tmp); } catch {}
            throw e;
          }
        } catch {}
      });
    });
    req.on('error', () => {});
    req.setTimeout(5000, () => req.destroy());
  `;
}

/**
 * If the cache is missing or stale, spawn a detached background process to refresh it.
 */
export function scheduleUpdateCheck() {
  try {
    if (process.env.NO_UPDATE_NOTIFIER || process.env.CI) return;

    // Check staleness
    if (fs.existsSync(CACHE_FILE)) {
      const { checkedAt } = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      if (checkedAt && Date.now() - checkedAt < STALE_MS) return;
    }

    const child = childProcess.spawn(process.execPath, ['-e', buildCheckScript(CONFIG_DIR, CACHE_FILE)], {
      detached: true,
      stdio: 'ignore'
    });
    child.unref();
  } catch {
    // silent
  }
}
