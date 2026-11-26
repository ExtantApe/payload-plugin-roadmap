# Changelog

## 0.5.0 (2026-11-26)

- New: `itemSources` option with `syncItemSources(payload)` and `syncItemSource(payload, key)`. External items become ordinary Roadmap items keyed by source key and id; sync updates title, summary and the source's vote count, marks vanished items `sourceGone` (never deletes), and leaves status and curator fields alone. Source items refuse Roadmap votes (a `RoadmapError` from `castVote` and `allocateVotes`), can't be merged into or out of, and can't have votes moved onto them. Their key is `source:<key>:<id>`, which no request can claim; one item that fails to sync is skipped and listed in `errors` on the result, and the rest still sync. `ItemSourceConfig.scope` sets the `scopeField` value for new items. `ItemSource` and `SourceItem` are structural types with no import from another plugin.
- New: `votes.lock` (default `true`), one setting for the whole Payload config. `false` lets voters withdraw placed votes at any time. `votes.lock` must be a boolean and `allocation.lockDays` a number of 0 or more, or the plugin refuses to start.
- Tested: 59 tests pass (12 new, in-memory MongoDB): create, re-sync without duplicates, removed item marked, curator stage and hidden survive, vote refusal (by message) through the API, curators and server helpers, merge into and out of a source item refused, a vote moved onto one refused, a request that slugifies like a source id can't block the sync, a bad item skipped with an error while the rest sync, signed-out and non-staff writes refused, the lock refusal (403) on a voter's own API delete with the lock on, and that delete succeeding with it off.
- Not tested: tags are ignored; `scopeField` sites (the `scope` option sets the value, but no test runs a tenant plugin); invalid `lock` and `lockDays` values at startup; a source with thousands of items; running sync concurrently; Postgres and SQLite.

## 0.4.2 (2026-11-11)

- Fix: with the catalog on and no `scopeField`, `roadmap-categories` asked MongoDB for two indexes both named `slug_1`, so the site couldn't start. It now asks for one: the `slug` field's own `slug_1`, unique (and sparse, as Payload makes it). With a `scopeField` nothing changes: `<scope>_1_slug_1` stays unique per scope, beside a plain `slug_1`, so scoped sites need no index migration.
