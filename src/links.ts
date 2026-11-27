/**
 * Which link targets the catalog accepts: a path on the site itself, or an https link to another host.
 *
 * A site path starts with one `/` and nothing that turns it into another host. Browsers read `//host` and
 * `/\host` as links to that host, and they drop tabs and newlines first, so a slash, a tab and a slash is `//host` too. Any
 * control character, space or backslash is refused. Dot segments (`/.//host`) and encoded slashes (`%2F`, `%5C`)
 * are refused too: they resolve to a path that starts with `//`, which a host's redirect can send off the site.
 * An https link must parse as a URL with a host.
 */
export function isSitePath(v: unknown): v is string {
  if (typeof v !== 'string' || !v.startsWith('/')) return false
  if (/[\u0000- \u007f\\]/.test(v) || v.startsWith('//')) return false
  const path = v.split(/[?#]/, 1)[0]!
  if (/%(2f|5c)/i.test(path) || path.split('/').some((seg) => seg === '.' || seg === '..')) return false
  try {
    return !new URL(v, 'https://site.invalid').pathname.startsWith('//')
  } catch {
    return false
  }
}

/** The safe links of a stored `links` value, skipping anything that isn't a `{ href }` entry, so one bad doc can't break a read. */
export function safeLinks(raw: unknown, ok: (href: unknown) => boolean = isSafeLink): { label: unknown; href: string }[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((l) => (l && typeof l === 'object' && ok((l as { href?: unknown }).href) ? [{ label: (l as { label?: unknown }).label, href: (l as { href: string }).href }] : []))
}

export function isHttpsLink(v: unknown): v is string {
  if (typeof v !== 'string' || !v.startsWith('https://') || /[\u0000- \u007f\\]/.test(v)) return false
  try {
    const u = new URL(v)
    return u.protocol === 'https:' && u.hostname !== '' && u.username === '' && u.password === ''
  } catch {
    return false
  }
}

export const isSafeLink = (v: unknown): v is string => isSitePath(v) || isHttpsLink(v)
