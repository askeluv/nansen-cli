/**
 * Credit cost cache — reads per-endpoint costs from a local cache populated
 * by an inline fetch of the Nansen OpenAPI spec (at most once per 24h).
 *
 * getCostForEndpoint(endpoint)  — sync, reads cache, returns { free, pro } or null
 * refreshCostMapIfStale()       — async, fetches inline if cache is missing or stale
 */

import fs from 'fs';
import path from 'path';

const CONFIG_DIR = path.join(process.env.HOME || process.env.USERPROFILE || '', '.nansen');
const CACHE_FILE = path.join(CONFIG_DIR, 'cost-map.json');
const STALE_MS = 24 * 60 * 60 * 1000; // 24 hours
const OPENAPI_URL = 'https://api.nansen.ai/openapi.json';

/**
 * Returns { free, pro } credit cost for the given API path, or null if unavailable.
 */
export function getCostForEndpoint(endpoint) {
  try {
    if (!fs.existsSync(CACHE_FILE)) return null;
    const { costs } = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    return costs?.[endpoint] ?? null;
  } catch {
    return null;
  }
}

/**
 * Fetches the OpenAPI spec and writes the cost map to disk if the cache is
 * missing or older than 24h. Awaited inline — only blocks on cold/stale cache.
 * Silent on any error.
 */
export async function refreshCostMapIfStale() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const { fetchedAt } = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      if (fetchedAt && Date.now() - fetchedAt < STALE_MS) return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    let spec;
    try {
      const res = await fetch(OPENAPI_URL, { signal: controller.signal });
      spec = await res.json();
    } finally {
      clearTimeout(timer);
    }

    const costs = {};
    for (const [p, methods] of Object.entries(spec.paths || {})) {
      for (const op of Object.values(methods)) {
        if (op['x-credit-cost']) {
          costs[p] = op['x-credit-cost'];
          break;
        }
      }
    }

    if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { mode: 0o700, recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ costs, fetchedAt: Date.now() }));
  } catch {
    // silent — network failure, parse error, write error
  }
}
