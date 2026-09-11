import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const paper = readFileSync('docs/PROTOCOL.md', 'utf8')

describe('whitepaper', () => {
  it('has all nine sections', () => {
    for (const heading of [
      'Threat model', 'Why not SOCKS5 over TLS', 'Frame format', 'Key schedule',
      'Nonces and ordering', 'Upstream dialling', 'Traffic analysis',
      'Plaintext mode', 'Limits',
    ]) {
      expect(paper, heading).toContain(heading)
    }
  })

  // The cryptographic strings are inputs, not labels. If the paper and the code
  // disagree, one of them is lying to an implementer.
  it('quotes the same cryptographic constants the code uses', () => {
    const code = readFileSync('src/protocol/crypto.ts', 'utf8')
    for (const constant of ['fp-relay/1 c2s', 'fp-relay/1 s2c', 'HKDF-SHA256', 'AES-256-GCM']) {
      expect(code + paper).toContain(constant)
      expect(paper, constant).toContain(constant)
    }
    expect(paper).toContain('16384')
  })

  // The limits section is the paper's credibility. Losing any of these lines
  // turns it into marketing.
  it('states every limit plainly', () => {
    const lower = paper.toLowerCase()
    for (const claim of [
      'forward secrecy', 'per deployment', 'tls inspection',
      'domain category', 'timing', 'traffic volume',
    ]) {
      expect(lower, claim).toContain(claim)
    }
  })

  it('does not overclaim about security appliances', () => {
    const lower = paper.toLowerCase()
    expect(lower).not.toMatch(/bypass(es|ing)? (any|all|every)/)
    expect(lower).not.toContain('undetectable')
    expect(lower).not.toContain('invisible to all')
  })

  it('names no private component or kernel project', () => {
    const lower = paper.toLowerCase()
    for (const word of ['fingerprint-chromium', 'fp-collect', 'cf-proxy', 'engine-gate', 'coming soon']) {
      expect(lower, word).not.toContain(word)
    }
  })

  it('has no non-ascii characters', () => {
    const bad = [...paper].filter((c) => c.charCodeAt(0) > 127)
    expect(bad, `non-ascii: ${bad.join('')}`).toEqual([])
  })
})
