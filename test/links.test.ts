import type { Config } from 'payload'
import { describe, expect, it } from 'vitest'

import { roadmapPlugin } from '../src'

const configure = (options: Parameters<typeof roadmapPlugin>[0] = {}) => roadmapPlugin(options)({ collections: [] } as unknown as Config)

// Stored links are checked again when the catalog is read, so a link saved before 0.5.1 tightened the check
// (or written around the admin) never reaches a page as an off-site redirect.
describe('catalog links on the way out', () => {
  it('drops stored links that point off the site or are not https', async () => {
    const { getCatalog } = await import('../src')
    const hrefs = ['/climate', 'https://example.com/a', '//evil.example', '/\\evil.example', '/\t/evil.example', '/\n/evil.example', 'javascript:alert(1)', 'http://example.com', 'https://']
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
})
