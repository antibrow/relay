import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// core/ and protocol/ have to compile and run on both Workers and Node, so a
// runtime-specific import there is a portability bug, not a style preference.
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : []
  })
}

describe('portability', () => {
  it('keeps runtime imports out of core and protocol', () => {
    const offenders = ['src/core', 'src/protocol']
      .flatMap(walk)
      .filter((f) => /from '(node:|cloudflare:)/.test(readFileSync(f, 'utf8')))
    expect(offenders).toEqual([])
  })
})
