import { mongooseAdapter } from '@payloadcms/db-mongodb'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import { buildConfig, getPayload, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { allocateVotes, castVote, syncItemSource, syncItemSources, withdrawVotes, roadmapPlugin, type SourceItem } from '../src/index.js'

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
    expect(await syncItemSources(a)).toEqual({ 'made-up-source': { created: 2, updated: 0, gone: 0 } })
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
    expect((await syncItemSource(a, 'made-up-source'))).toEqual({ created: 0, updated: 2, gone: 0 })
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
    const id = String((await items(a)).find((d) => d.externalId === 'lang:aa')!.id)
    await expect(castVote(a, { item: id, user: String(voterA.id) })).rejects.toThrow()
    await expect(
      a.create({ collection: 'roadmap-votes' as never, data: { item: id } as never, user: asUser(voterA), overrideAccess: false }),
    ).rejects.toThrow()
    await expect(allocateVotes(a, { item: id, user: String(voterA.id), votes: 1 })).rejects.toThrow()
    expect((await items(a)).find((d) => String(d.id) === id)!.voteCount).toBe(9)
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
})

describe('votes.lock', () => {
  const place = async (p: Payload, user: Doc) => {
    const item = (await p.create({ collection: 'roadmap-items' as never, data: { title: `Made-up ${p === a ? 'a' : 'b'}`, board: 'features' } as never, overrideAccess: true })) as Doc
    await allocateVotes(p, { item: String(item.id), user: String(user.id), votes: 2 })
    return String(item.id)
  }

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
