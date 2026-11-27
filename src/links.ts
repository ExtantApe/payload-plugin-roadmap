/**
 * Which link targets the catalog accepts: a path on the site itself, or an https link to another host.
 *
 * A site path starts with one `/` and nothing that turns it into another host. Browsers read `//host` and
 * `/\host` as links to that host, and they drop tabs and newlines first, so a slash, a tab and a slash is `//host` too. Any
 * control character, space or backslash is refused. An https link must parse as a URL with a host.
 */
export function isSitePath(v: unknown): v is string {
  if (typeof v !== 'string' || !v.startsWith('/')) return false
  if (/[\u0000- \u007f\\]/.test(v)) return false
  return !v.startsWith('//')
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
