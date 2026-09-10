'use strict'

// Source transform for `@deepseek-ai/dsh-llm-deepseek/lib/index.js`.
//
// DeepSeek's public API (GET https://api.deepseek.com/models) now serves
// `deepseek-flash` and `deepseek-v4-pro`; `deepseek-v4-flash` is only kept alive
// server-side as an alias of `deepseek-flash`. The vendor package still ships
// the pre-rename catalog, so the web model picker never offers the current
// Flash model. This patch prepends it to `DEFAULT_MODELS`, which is the single
// source behind `llm.models` / `session.models` / the Models settings page.
//
// Same provider route (`deepseek-official`) => same base URL
// (https://api.deepseek.com) and same credential (DEEPSEEK_API_KEY); nothing
// about api / key resolution changes. Merely *listing* a model is advisory:
// the adapter passes any model id through unchanged either way.
//
// Kept as a transform instead of a vendored file copy so a package upgrade
// cannot silently replace it with a stale whole-file snapshot.

/** Anchor the insertion on the catalog declaration itself, not on entry formatting. */
const ANCHOR = 'const DEFAULT_MODELS = ['

/** New catalog entry, formatted like the vendor entries that follow it. */
const ENTRY = [
  '\n// dsh-desktop patch: DeepSeek-Flash (current Flash model on api.deepseek.com)',
  '\n{',
  '\n        id: "deepseek-flash",',
  '\n        name: "DeepSeek-Flash",',
  '\n        contextWindow: DEFAULT_CONTEXT_WINDOW',
  '\n},',
  '\n',
].join('')

/**
 * Prepend `deepseek-flash` to the DeepSeek official model catalog.
 * @param source - contents of `dsh-llm-deepseek/lib/index.js`.
 * @returns the patched source; identical when the entry is already present.
 * @throws when the vendor catalog declaration cannot be found (layout changed).
 */
module.exports = function addFlashModel(source) {
  if (source.includes('id: "deepseek-flash"')) return source

  const at = source.indexOf(ANCHOR)
  if (at === -1) {
    throw new Error(
      'dsh-llm-deepseek: DEFAULT_MODELS declaration not found; vendor layout changed, update patches/dsh-llm-deepseek/flash-model.cjs'
    )
  }

  const insertAt = at + ANCHOR.length
  return source.slice(0, insertAt) + ENTRY + source.slice(insertAt)
}
