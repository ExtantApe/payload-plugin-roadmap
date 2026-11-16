# Changelog

## Unreleased

- New: `itemSources` option with `syncItemSources(payload)` and `syncItemSource(payload, key)`. External items become ordinary Roadmap items keyed by source key and id; sync updates title, summary and the source's vote count, marks vanished items `sourceGone` (never deletes), and leaves status and curator fields alone. Source items refuse Roadmap votes. `ItemSource` and `SourceItem` are structural types with no import from another plugin.
- New: `votes.lock` (default `true`). `false` lets voters withdraw placed votes at any time.
- Tested: 55 tests pass (8 new, in-memory MongoDB): create, re-sync without duplicates, removed item marked, curator stage and hidden survive, vote refusal through the API and server helpers, signed-out and non-staff writes refused, lock on and off.
- Not tested: tags are ignored; `scopeField` sites (source items get no scope); a source with thousands of items; running sync concurrently; Postgres and SQLite.

## 0.4.2 (2026-11-11)

- Fix: with the catalog on and no `scopeField`, `roadmap-categories` asked MongoDB for two indexes both named `slug_1`, so the site couldn't start. It now asks for one: the `slug` field's own `slug_1`, unique (and sparse, as Payload makes it). With a `scopeField` nothing changes: `<scope>_1_slug_1` stays unique per scope, beside a plain `slug_1`, so scoped sites need no index migration.
