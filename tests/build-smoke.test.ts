import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

// Every other suite exercises src/*.ts through vitest's own resolver, which
// tolerates the extensionless relative imports tsc leaves in dist/*.js for
// plain Node's ESM loader to choke on (see scripts/fix-esm-extensions.mjs).
// That gap is exactly what let a build that could not run at all pass every
// test and both typechecks through 16 prior tasks. This test builds for real
// and runs the real compiled file, so removing or breaking the fix script
// fails here instead of only being caught by a human running the artifact.
describe('build smoke test', () => {
  it('builds and runs dist/cli.js keygen', () => {
    execFileSync('npm', ['run', 'build'], { stdio: 'pipe' })
    const out = execFileSync('node', ['dist/cli.js', 'keygen'], { encoding: 'utf8' }).trim()
    const bytes = Buffer.from(out, 'base64url')
    expect(bytes.length).toBe(32)
  })
})
