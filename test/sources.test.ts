import { mongooseAdapter } from '@payloadcms/db-mongodb'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import { buildConfig, getPayload, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { allocateVotes, castVote, mergeItems, requestItem, syncItemSource, syncItemSources, withdrawVotes, roadmapPlugin, type SourceItem } from '../src/index.js'

// Item sources and vote locking on real Payload over an in-memory MongoDB. Made-up data only.
type Doc = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

let mongo: MongoMemoryReplSet
let a: Payload // locking on (default)
let b: Payload // votes.lock false
let listed: SourceItem[] = []
const source = { key: 'made-up-source', list: async () => listed }
const PASSWORD = 'a-made-up-test-password'
let voterA: Doc, voterB: Doc, curatorA: Doc

const build = async (db: string, lock?: boolean) =>
  getPayload({
    key: db,
    config: await buildConfig({
      secret: 'test-secret-not-for-production',
      telemetry: false,
      typescript: { autoGenerate: false },
      db: mongooseAdapter({ url: mongo.getUri(db), ensureIndexes: true }),
      collections: [{ slug: 'users', auth: true, fields: [{ name: 'role', type: 'text' }] }],
      plugins: [
        roadmapPlugin({
          itemSources: [{ source, board: 'features' }],
          allocation: { earned: async () => 5, lockDays: 30 },
          ...(lock === undefined ? {} : { votes: { lock } }),
          access: { manage: ({ req }) => (req.user as Doc | null)?.role === 'curator' },
        }),
      ],
    }),
  })

const items = async (p: Payload) => (await p.find({ collection: 'roadmap-items' as never, pagination: false, overrideAccess: true })).docs as Doc[]

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } })
  a = await build('sources-a')
  b = await build('sources-b', false)
  for (const p of [a, b]) {
    const models = (p.db as unknown as { collections: Record<string, { ensureIndexes: () => Promise<unknown> }> }).collections
    for (const m of Object.values(models)) await m.ensureIndexes()
  }
  const user = (email: string, role = 'voter') => a.create({ collection: 'users', data: { email, password: PASSWORD, role } as never }) as Promise<Doc>
  voterA = await user('v1@example.com')
  voterB = await user('v2@example.com')
  curatorA = await user('curator@example.com', 'curator')
}, 180_000)

afterAll(async () => {
  await a?.destroy()
  await b?.destroy()
  await mongo?.stop()
})

const asUser = (u: Doc) => ({ ...u, collection: 'users' }) as never

describe('item sources', () => {
  it('creates ordinary items from the source', async () => {
    listed = [
      { externalId: 'lang:aa', title: 'Made-up tongue', description: 'About it', votes: 3 },
      { externalId: 'lang:bb', title: 'Other tongue', votes: 0 },
    ]
    expect(await syncItemSources(a)).toEqual({ 'made-up-source': { created: 2, updated: 0, gone: 0, errors: [] } })
    const docs = await items(a)
    expect(docs).toHaveLength(2)
    expect(docs.find((d) => d.externalId === 'lang:aa')).toMatchObject({ title: 'Made-up tongue', summary: 'About it', voteCount: 3, sourceVotes: 3, board: 'features', stage: 'requested', sourceKey: 'made-up-source', sourceGone: false })
  })

  it('re-sync updates counts and text without duplicates, and keeps curator fields', async () => {
    const aa = (await items(a)).find((d) => d.externalId === 'lang:aa')!
    await a.update({ collection: 'roadmap-items' as never, id: aa.id, data: { stage: 'planned', hidden: true } as never, overrideAccess: true })
    listed = [
      { externalId: 'lang:aa', title: 'Made-up tongue (renamed)', votes: 9 },
      { externalId: 'lang:bb', title: 'Other tongue', votes: 1 },
    ]
    expect((await syncItemSource(a, 'made-up-source'))).toEqual({ created: 0, updated: 2, gone: 0, errors: [] })
    const docs = await items(a)
    expect(docs).toHaveLength(2)
    expect(docs.find((d) => d.externalId === 'lang:aa')).toMatchObject({ title: 'Made-up tongue (renamed)', voteCount: 9, sourceVotes: 9, stage: 'planned', hidden: true })
  })

  it('marks a removed item instead of deleting it, and clears the mark when it returns', async () => {
    listed = [{ externalId: 'lang:aa', title: 'Made-up tongue', votes: 9 }]
    expect(await syncItemSource(a, 'made-up-source')).toMatchObject({ gone: 1 })
    let docs = await items(a)
    expect(docs).toHaveLength(2)
    expect(docs.find((d) => d.externalId === 'lang:bb')).toMatchObject({ sourceGone: true, stage: 'requested' })
    listed = [{ externalId: 'lang:aa', title: 'Made-up tongue', votes: 9 }, { externalId: 'lang:bb', title: 'Other tongue', votes: 2 }]
    await syncItemSource(a, 'made-up-source')
    docs = await items(a)
    expect(docs.find((d) => d.externalId === 'lang:bb')).toMatchObject({ sourceGone: false, voteCount: 2 })
  })

  it('refuses unknown sources', async () => {
    await expect(syncItemSource(a, 'nope')).rejects.toThrow(/No item source/)
  })

  it('refuses a Roadmap vote on a source item, through the API and the server helpers', async () => {
    const doc = (await items(a)).find((d) => d.externalId === 'lang:aa')!
    const id = String(doc.id)
    await a.update({ collection: 'roadmap-items' as never, id, data: { hidden: false } as never, overrideAccess: true })
    await expect(castVote(a, { item: id, user: String(voterA.id) })).rejects.toThrow(/page it came from/)
    await expect(
      a.create({ collection: 'roadmap-votes' as never, data: { item: id } as never, user: asUser(voterA), overrideAccess: false }),
    ).rejects.toThrow(/page it came from/)
    await expect(
      a.create({ collection: 'roadmap-votes' as never, data: { item: id, user: curatorA.id } as never, user: asUser(curatorA), overrideAccess: false }),
    ).rejects.toThrow(/page it came from/)
    await expect(allocateVotes(a, { item: id, user: String(voterA.id), votes: 1 })).rejects.toThrow(/page it came from/)
    expect((await items(a)).find((d) => String(d.id) === id)!.voteCount).toBe(9)
    await a.update({ collection: 'roadmap-items' as never, id, data: { hidden: true } as never, overrideAccess: true })
  })

  it('does not let signed-out or non-staff users write source fields', async () => {
    const doc = (await items(a)).find((d) => d.externalId === 'lang:aa')!
    const attempts = [undefined, asUser(voterA)]
    for (const user of attempts) {
      await expect(
        a.create({ collection: 'roadmap-items' as never, data: { title: 'Sneaky', sourceKey: 'made-up-source', externalId: 'x' } as never, user, overrideAccess: false }),
      ).rejects.toThrow()
      await expect(
        a.update({ collection: 'roadmap-items' as never, id: doc.id, data: { sourceVotes: 99, sourceGone: true, voteCount: 99 } as never, user, overrideAccess: false }),
      ).rejects.toThrow()
    }
    // Even staff cannot set source fields through the API; only the sync can.
    await a.update({ collection: 'roadmap-items' as never, id: doc.id, data: { sourceVotes: 99, sourceGone: true, externalId: 'zzz' } as never, user: asUser(curatorA), overrideAccess: false })
    expect((await items(a)).find((d) => d.id === doc.id)).toMatchObject({ sourceVotes: 9, sourceGone: false, externalId: doc.externalId })
  })

  it('refuses merging into or out of a source item, and moving a vote onto one', async () => {
    const src = (await items(a)).find((d) => d.externalId === 'lang:aa')!
    const plain = (await a.create({ collection: 'roadmap-items' as never, data: { title: 'Made-up plain', board: 'features' } as never, overrideAccess: true })) as Doc
    const vote = (await a.create({ collection: 'roadmap-votes' as never, data: { item: plain.id, user: voterB.id } as never, overrideAccess: true })) as Doc
    const asCurator = { user: asUser(curatorA), overrideAccess: false }
    await expect(a.update({ collection: 'roadmap-items' as never, id: plain.id, data: { mergedInto: src.id } as never, ...asCurator })).rejects.toThrow(/can’t be merged into or out of/)
    await expect(a.update({ collection: 'roadmap-items' as never, id: src.id, data: { mergedInto: plain.id } as never, ...asCurator })).rejects.toThrow(/can’t be merged into or out of/)
    await expect(mergeItems(a, { from: plain.id, into: src.id })).rejects.toThrow(/merged into or out of/)
    await expect(mergeItems(a, { from: src.id, into: plain.id })).rejects.toThrow(/merged into or out of/)
    await expect(a.update({ collection: 'roadmap-votes' as never, id: vote.id, data: { item: src.id } as never, ...asCurator })).rejects.toThrow(/can’t be moved onto/)
    const after = await items(a)
    expect(after.find((d) => d.id === src.id)).toMatchObject({ voteCount: 9, hidden: true })
    expect(after.find((d) => d.id === plain.id)).toMatchObject({ voteCount: 1 })
    expect(after.find((d) => d.id === plain.id)!.mergedInto).toBeFalsy()
  })

  it('gives source items a key no request can claim, and one bad item never stops the sync', async () => {
    // A request whose title slugifies to the old source slug.
    await requestItem(a, { board: 'features', title: 'made-up-source lang aa', user: String(voterB.id) } as never)
    listed = [
      { externalId: 'lang:zu', title: 'Zu tongue', votes: 1 },
      { externalId: 'lang-zu', title: 'Zu again', votes: 2 },
      { externalId: 'lang:empty', title: '', votes: 1 },
      { externalId: 'lang:last', title: 'Last tongue', votes: 4 },
    ]
    const res = await syncItemSource(a, 'made-up-source')
    expect(res.created).toBe(3)
    expect(res.errors).toHaveLength(1)
    expect(res.errors[0]).toMatchObject({ externalId: 'lang:empty' })
    const docs = await items(a)
    expect(docs.find((d) => d.externalId === 'lang:last')).toMatchObject({ voteCount: 4, key: 'source:made-up-source:lang:last' })
    expect(docs.filter((d) => ['lang:zu', 'lang-zu'].includes(d.externalId))).toHaveLength(2)
    // The items left out of this list are marked gone, so gone-marking still ran.
    expect(docs.find((d) => d.externalId === 'lang:aa')).toMatchObject({ sourceGone: true })
  })
})

describe('votes.lock', () => {
  const place = async (p: Payload, user: Doc) => {
    const item = (await p.create({ collection: 'roadmap-items' as never, data: { title: `Made-up ${p === a ? 'a' : 'b'} ${Math.random().toString(36).slice(2, 8)}`, board: 'features' } as never, overrideAccess: true })) as Doc
    await allocateVotes(p, { item: String(item.id), user: String(user.id), votes: 2 })
    return String(item.id)
  }

  const placed = async (p: Payload, user: Doc) => {
    const id = await place(p, user)
    const v = (await p.find({ collection: 'roadmap-votes' as never, where: { item: { equals: id } }, overrideAccess: true })).docs[0] as Doc
    return String(v.id)
  }

  it('on: a voter cannot delete a locked placed vote through the API (403)', async () => {
    const vote = await placed(a, voterB)
    await expect(a.delete({ collection: 'roadmap-votes' as never, id: vote, user: asUser(voterB), overrideAccess: false })).rejects.toMatchObject({
      status: 403,
      message: 'These votes are still committed.',
    })
    expect((await a.find({ collection: 'roadmap-votes' as never, where: { id: { equals: vote } }, overrideAccess: true })).totalDocs).toBe(1)
  })

  it('off: the same API delete succeeds', async () => {
    const user = (await b.create({ collection: 'users', data: { email: 'v4@example.com', password: PASSWORD } as never })) as Doc
    const vote = await placed(b, user)
    await b.delete({ collection: 'roadmap-votes' as never, id: vote, user: { ...user, collection: 'users' } as never, overrideAccess: false })
    expect((await b.find({ collection: 'roadmap-votes' as never, where: { id: { equals: vote } }, overrideAccess: true })).totalDocs).toBe(0)
  })

  it('on by default: placed votes stay committed for lockDays', async () => {
    const id = await place(a, voterA)
    expect(await withdrawVotes(a, { item: id, user: String(voterA.id) })).toBe(0)
  })

  it('off: placed votes can be withdrawn at once', async () => {
    const user = (await b.create({ collection: 'users', data: { email: 'v3@example.com', password: PASSWORD } as never })) as Doc
    const id = await place(b, user)
    expect(await withdrawVotes(b, { item: id, user: String(user.id) })).toBe(2)
  })
})
