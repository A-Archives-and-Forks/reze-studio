// Two things Node's ESM loader will not do that the app's bundler does, and
// that a unit test needs anyway.
//
// 1. `@/lib/...` — the project's own path alias, declared in tsconfig. Node
//    knows nothing about tsconfig, so it is mapped here to the project root.
// 2. Extensionless relative imports. reze-engine's published `dist` is written
//    for a bundler (`./engine`, `./math`), and the studio's own source omits
//    the `.ts` on aliased imports for the same reason.
//
// Both retries only run AFTER normal resolution has already failed, so nothing
// that resolves on its own passes through here and a genuinely missing module
// still reports as missing.

import { pathToFileURL } from "node:url"

const ROOT = new URL("../../", import.meta.url)
const SUFFIXES = ["", ".ts", ".tsx", ".js", ".mjs", "/index.ts", "/index.js"]

async function tryAll(base, context, nextResolve) {
  for (const suffix of SUFFIXES) {
    try {
      return await nextResolve(base + suffix, context)
    } catch {
      // Next shape.
    }
  }
  return null
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    const base = new URL(specifier.slice(2), ROOT).href
    const hit = await tryAll(base, context, nextResolve)
    if (hit) return hit
    throw new Error(`Cannot resolve alias ${specifier} under ${ROOT.href}`)
  }
  try {
    return await nextResolve(specifier, context)
  } catch (err) {
    const retriable = err?.code === "ERR_MODULE_NOT_FOUND" || err?.code === "ERR_UNSUPPORTED_DIR_IMPORT"
    if (!retriable || !specifier.startsWith(".")) throw err
    const hit = await tryAll(specifier, context, nextResolve)
    if (hit) return hit
    throw err
  }
}

// Referenced so the import is not mistaken for dead weight if this file grows.
void pathToFileURL
