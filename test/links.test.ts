import type { Config } from 'payload'
import { describe, expect, it } from 'vitest'

import { roadmapPlugin } from '../src'

const configure = (options: Parameters<typeof roadmapPlugin>[0] = {}) => roadmapPlugin(options)({ collections: [] } as unknown as Config)

// Stored links are checked again when the catalog is read, so a link saved before 0.5.1 tightened the check
// (or written around the admin) never reaches a page as an off-site redirect.
describe('catalog links on the way out', () => {
  it('drops stored links that point off the site or are not https', async () => {
    const { getCatalog } = await import('../src')
    const hrefs = ['/climate', 'https://example.com/a', '//evil.example', '/\\evil.example', '/\t/evil.example', '/\n/evil.example', 'javascript:alert(1)', 'http://example.com', 'https://', '/.//evil.example', '/%2F/evil.example']
    const payload = {
      config: configure({ catalog: {} }),
      find: async (args: { collection: string }) =>
        args.collection === 'roadmap-categories'
          ? { docs: [{ id: 'c1', slug: 'climate', title: 'Climate' }] }
          : { docs: [{ id: 'a', slug: 'score', title: 'Score', stage: 'released', category: 'c1', links: hrefs.map((href) => ({ label: href, href })) }] },
    }
    const [section] = await getCatalog(payload as never)
    expect(section!.entries[0]!.links.map((l) => l.href)).toEqual(['/climate', 'https://example.com/a'])
  })
  it('reads past malformed stored links instead of throwing', async () => {
    const { getCatalog } = await import('../src')
    const docs = (links: unknown) => ({
      config: configure({ catalog: {} }),
      find: async (args: { collection: string }) =>
        args.collection === 'roadmap-categories' ? { docs: [{ id: 'c1', slug: 'climate', title: 'Climate' }] } : { docs: [{ id: 'a', slug: 'score', title: 'Score', stage: 'released', category: 'c1', links }] },
    })
    for (const links of ['/climate', { href: '/climate' }, 7]) expect((await getCatalog(docs(links) as never))[0]!.entries[0]!.links).toEqual([])
    const [section] = await getCatalog(docs([null, 'x', { href: '/climate', label: { html: '<b>' } }, { label: 'Ok', href: '/ok' }]) as never)
    expect(section!.entries[0]!.links).toEqual([
      { label: '/climate', href: '/climate' },
      { label: 'Ok', href: '/ok' },
    ])
  })
})
