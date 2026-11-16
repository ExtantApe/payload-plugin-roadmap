# Decisions

## 2026-11-16: item sources and per-site vote locking

The owner, 2026-11-16: "languages should appear with everything else and yes, votes don't need to be locked. That should be adjustable per implementation."

- Roadmap takes external items through an `itemSources` option and sync functions. They become ordinary items, so they appear with everything else on a board. Neither plugin imports the other; the source shape is a structural type here.
- Sync never deletes: an item a source stops listing is marked `sourceGone`, because a curator may have edited it. Roadmap's own fields are left alone, and source items take no Roadmap votes so nothing is counted twice.
- Vote locking is `votes.lock`, default `true` (today's behavior). `false` ignores `allocation.lockDays` for that site.
