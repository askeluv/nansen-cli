---
"nansen-cli": patch
---

Fix `nansen changelog --since <version>` silently returning "No changelog entries found" for a version missing its patch number (e.g. `--since 1.43` instead of `--since 1.43.0`), even when matching entries exist. The comparison compared the missing component against `undefined`, and `>` is always `false` against `undefined` in both directions, so a version that matched on major.minor always came out "less than" the since-value. A missing component is now treated as `0`, and a `--since` value that isn't a valid version (e.g. `--since abc`) now prints a clear error instead of silently matching nothing.

The version-comparison logic is now shared (`src/semver.js`) between `nansen changelog --since` and the update-notifier's `isNewer` check, which had the identical bug in its own separate parser. `isNewer` couldn't misfire in practice (both versions it compares are always fully-qualified x.y.z today), but it's the same defect class, so it's fixed the same way rather than left in place.
