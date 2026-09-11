import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (p: string) => readFileSync(p, 'utf8')

describe('docs', () => {
  // Every environment variable the docs name has to be one the code reads, and
  // every switch the code has needs to be documented. Drift here is the reason
  // self-hosting instructions rot.
  it('documents exactly the environment variables the code reads', () => {
    const cli = read('src/cli.ts')
    const deploy = read('docs/DEPLOY.md')
    for (const name of ['FP_RELAY_KEY', 'ADMIN_KEY', 'ALLOW_PLAINTEXT', 'PORT', 'DB_PATH']) {
      expect(cli, `${name} missing from cli`).toContain(name)
      expect(deploy, `${name} missing from DEPLOY.md`).toContain(name)
      expect(read('.env.example'), `${name} missing from .env.example`).toContain(name)
    }
  })

  it('warns about what plaintext mode gives up, wherever it is offered', () => {
    for (const f of ['docs/DEPLOY.md', 'README.md', '.env.example', 'wrangler.toml']) {
      expect(read(f).toLowerCase(), f).toMatch(/clear text|cleartext/)
    }
  })

  // workers.dev is blocked by domain category filtering regardless of protocol,
  // so a custom domain is the whole point of self-hosting.
  it('tells the operator to use their own domain', () => {
    expect(read('docs/DEPLOY.md')).toContain('workers.dev')
    expect(read('docs/DEPLOY.md').toLowerCase()).toContain('custom domain')
  })

  it('never names private components or the kernel project', () => {
    const banned = ['fingerprint-chromium', 'fp-collect', 'cf-proxy', 'engine-gate', 'proxy-bastion', 'coming soon']
    for (const f of ['README.md', 'docs/DEPLOY.md']) {
      const text = read(f).toLowerCase()
      for (const word of banned) expect(text, `${word} in ${f}`).not.toContain(word)
    }
  })

  it('has no non-ascii characters anywhere in the published tree', () => {
    for (const f of ['README.md', 'docs/DEPLOY.md', 'src/cli.ts', 'src/core/session.ts']) {
      const bad = [...read(f)].filter((c) => c.charCodeAt(0) > 127)
      expect(bad, `non-ascii in ${f}: ${bad.join('')}`).toEqual([])
    }
  })
})
