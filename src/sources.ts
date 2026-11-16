import type { CollectionSlug, Payload } from 'payload'

import { optionsOf, RoadmapError } from './api'
import type { ItemSourceConfig, SourceItem } from './types'

export type SyncResult = { created: number; updated: number; gone: number; errors: { externalId: string; message: string }[] }

type Existing = { id: string; sourceGone?: boolean | null }

/** Display slug only. The unique key is `source:<key>:<id>`, set by the items hook, so slugs may repeat. */
const slugFor = (key: string, externalId: string) =>
  `${key}-${externalId}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120)

const syncOne = async (payload: Payload, cfg: ItemSourceConfig) => {
  const opts = optionsOf(payload)
  const items = opts.slugs.items as CollectionSlug
  const { key } = cfg.source
  const stage = cfg.status ?? opts.stages[0]!.value
  if (!opts.boards.some((b) => b.value === cfg.board)) throw new RoadmapError(`Item source ${key}: unknown board ${cfg.board}.`)
  if (!opts.stages.some((s) => s.value === stage)) throw new RoadmapError(`Item source ${key}: unknown stage ${stage}.`)
  const listed: SourceItem[] = await cfg.source.list({ payload })
  const known = new Map<string, Existing>(
    (
      (await payload.find({ collection: items, where: { sourceKey: { equals: key } }, pagination: false, depth: 0, overrideAccess: true })).docs as unknown as (Existing & {
        externalId: string
      })[]
    ).map((d) => [d.externalId, d]),
  )
  const result: SyncResult = { created: 0, updated: 0, gone: 0, errors: [] }
  const seen = new Set<string>()
  for (const s of listed) {
    if (seen.has(s.externalId)) continue
    seen.add(s.externalId)
    try {
    const votes = Math.max(0, Math.floor(Number(s.votes) || 0))
    const have = known.get(s.externalId)
    const shared = { title: s.title, summary: s.description ?? '', sourceVotes: votes, voteCount: votes, sourceGone: false }
    if (have) {
      // Only the source's fields: stage, curator notes, hidden and the rest stay as they are.
      await payload.update({ collection: items, id: have.id, data: shared as never, overrideAccess: true, context: { roadmapInternal: true } })
      result.updated++
    } else {
      await payload.create({
        collection: items,
        data: { ...shared, board: cfg.board, stage, slug: slugFor(key, s.externalId), sourceKey: key, externalId: s.externalId, ...(opts.scopeField && cfg.scope ? { [opts.scopeField]: cfg.scope } : {}) } as never,
        overrideAccess: true,
        context: { roadmapInternal: true },
      })
      result.created++
    }
    } catch (error) {
      // One bad item never stops the rest.
      result.errors.push({ externalId: String(s.externalId), message: error instanceof Error ? error.message : 'Could not sync this item.' })
    }
  }
  // Never deleted: a curator may have edited it. Marked, so the site can say the source dropped it.
  for (const [externalId, have] of known)
    if (!seen.has(externalId) && !have.sourceGone) {
      await payload.update({ collection: items, id: have.id, data: { sourceGone: true } as never, overrideAccess: true, context: { roadmapInternal: true } })
      result.gone++
    }
  return result
}

/** Sync one configured item source (call it from the source's own afterChange hook). Server only. */
export async function syncItemSource(payload: Payload, key: string) {
  const cfg = optionsOf(payload).itemSources.find((c) => c.source.key === key)
  if (!cfg) throw new RoadmapError(`No item source named ${key}.`)
  return syncOne(payload, cfg)
}

/** Sync every configured item source. Server only; runs with overrideAccess. */
export async function syncItemSources(payload: Payload) {
  const out: Record<string, SyncResult> = {}
  for (const cfg of optionsOf(payload).itemSources) out[cfg.source.key] = await syncOne(payload, cfg)
  return out
}
