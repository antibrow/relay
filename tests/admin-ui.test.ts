import { describe, expect, it } from 'vitest'
import { adminHtml } from '../src/admin/ui'

describe('admin page', () => {
  const html = adminHtml()

  it('has both management sections', () => {
    expect(html).toContain('data-tab="accounts"')
    expect(html).toContain('data-tab="upstreams"')
  })

  it('talks to the api paths the server serves', () => {
    expect(html).toContain('/admin/accounts')
    expect(html).toContain('/admin/upstreams')
  })

  // The key is typed by the operator and kept in the tab, never rendered into
  // the page by the server - the page is served to anyone who can reach /admin.
  it('never embeds a key and keeps the typed one in sessionStorage', () => {
    expect(html).toContain('sessionStorage')
    expect(html).not.toMatch(/x-admin-key['"]\s*:\s*['"][^'"]+['"]/)
  })

  it('offers a generated password and a copyable relay url', () => {
    expect(html).toContain('getRandomValues')
    expect(html).toContain('relay://')
  })

  // Before a key is entered, state.accounts/state.upstreams are empty for the
  // same reason an empty fetch result would be - the page must not read that
  // as "there are none" before it has asked the server anything.
  it('distinguishes not-yet-loaded from a genuinely empty list', () => {
    expect(html).toContain('Enter your admin key above to load accounts.')
    expect(html).toContain('Enter your admin key above to load upstreams.')
    expect(html).toContain('state.loaded')
  })

  it('is self-contained: no external script or style', () => {
    expect(html).not.toMatch(/<script[^>]+src=/)
    expect(html).not.toMatch(/<link[^>]+stylesheet/)
  })

  // Nothing in this suite executes the page's client script, so this is the only
  // guard on its escaping. Keep it general: it has to fail for the next unescaped
  // attribute someone adds, not just for the ones fixed today.
  it('escapes every value interpolated into an attribute', () => {
    const attrInterpolations = html.match(/="\$\{[^}]*\}/g) ?? []
    expect(attrInterpolations.length).toBeGreaterThan(0)
    const unescaped = attrInterpolations.filter((m) => !m.includes('esc('))
    expect(unescaped).toEqual([])
  })
})
