// tsc emits relative imports exactly as written in src (no extension), because
// tsconfig.build.json uses moduleResolution "bundler" so the editor and vitest
// resolve those the same way as everything else. Plain Node's ESM loader has
// no bundler in front of it and refuses to resolve an extensionless relative
// specifier, so dist/cli.js cannot run until every such specifier gets its
// .js back. This only touches the compiled output, never src.
//
// The rewrite below only matches a single-quoted `from '...'` - the only shape
// this codebase's imports actually take. It will not touch a side-effect
// `import './x'`, a dynamic `import('./x')`, or a double-quoted specifier if
// one is ever added. Rather than trust that silently, the check below re-scans
// the emitted output for any of those shapes left without an extension and
// fails the build loudly, naming the file and line, instead of shipping a
// dist/cli.js that only fails for the person who runs it.
//
// The alternative is writing the .js extension directly on every relative
// import in src (bundler resolution accepts a .js specifier that resolves to
// a sibling .ts file, and esbuild - what Wrangler bundles with - has the same
// fallback, so nothing else would need to change). That is the better fix in
// the abstract: no script to maintain, nothing to fall out of sync with a
// refactor. It was not taken here because it touches every relative import in
// the tree at the end of an already-reviewed, already-tested plan, to replace
// something that already works and is idempotent. tests/build-smoke.test.ts
// builds for real and runs the real dist/cli.js, but only exercises one path
// through one import graph - the loud failure below is what covers the rest.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const HAS_EXT = /\.(js|json|mjs|cjs|node)$/
// Matches a relative specifier after `from` (import or re-export) or after
// `import` (a side-effect import, or a dynamic import's opening paren).
const SPECIFIER_RE = /\b(?:from|import)\b\s*\(?\s*['"](\.\.?\/[^'"]+)['"]/g

let failed = false

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) { walk(full); continue }
    if (!full.endsWith('.js')) continue
    const src = readFileSync(full, 'utf8')
    const fixed = src.replace(/from '(\.\.?\/[^']+)'/g, (m, spec) => (
      HAS_EXT.test(spec) ? m : `from '${spec}.js'`
    ))
    if (fixed !== src) writeFileSync(full, fixed)
    checkForNakedSpecifiers(full, fixed)
  }
}

function checkForNakedSpecifiers(file, source) {
  SPECIFIER_RE.lastIndex = 0
  let m
  while ((m = SPECIFIER_RE.exec(source))) {
    if (HAS_EXT.test(m[1])) continue
    const line = source.slice(0, m.index).split('\n').length
    console.error(`fix-esm-extensions: naked relative specifier '${m[1]}' at ${file}:${line} - Node's ESM loader will refuse to resolve this`)
    failed = true
  }
}

walk('dist')
if (failed) process.exit(1)
