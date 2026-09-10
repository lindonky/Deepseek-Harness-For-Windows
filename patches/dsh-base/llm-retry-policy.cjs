'use strict'

// Source transform for `@deepseek-ai/dsh-base/cordis.patch.yml`.
//
// The `deepseek-official` adapter's retry policy defaults to
// `maxRetries: 2` with a 500ms→10s backoff: roughly 1.5 seconds of tolerance
// for the whole request. A transient DNS/TLS/Wi-Fi hiccup longer than that
// exhausts the retries and aborts the running task outright, which surfaces as
// "DeepSeek API request to https://api.deepseek.com failed".
//
// TRANSPORT is already in the vendor's default `retryableCodes`, so only the
// budget needs raising: 8 retries with a 1s→30s backoff tolerates roughly two
// minutes of outage before the task is allowed to fail. `retryableCodes` is
// deliberately left out so the vendor's default set (and any future additions)
// keeps applying.
//
// The user's own `$DSH_HOME/settings.yaml` -> `llm-deepseek.retryPolicy` still
// wins over this entry, exactly as documented for every other adapter field.

/** Anchored on the adapter entry rather than on surrounding comments. */
const ANCHOR = [
  '    - id: llm-deepseek',
  "      name: '@deepseek-ai/dsh-llm-deepseek'",
].join('\n')

const BLOCK = [
  '      config:',
  '        retryPolicy:',
  '          mode: normal',
  '          maxRetries: 8',
  '          backoff:',
  '            initialDelayMs: 1000',
  '            maxDelayMs: 30000',
  '            jitterRatio: 0.2',
].join('\n')

const PATCHED = `${ANCHOR}\n${BLOCK}`

/**
 * Raise the DeepSeek adapter's retry budget.
 * @param source - contents of `@deepseek-ai/dsh-base/cordis.patch.yml`.
 * @returns the patched YAML; identical when already applied.
 * @throws when the anchor is missing or the entry already owns a config block
 *   (a duplicate `config:` key would be an invalid document, so fail loudly
 *   here instead of shipping an app that cannot boot).
 */
module.exports = function raiseDeepSeekRetryBudget(source) {
  if (source.includes(PATCHED)) return source
  const at = source.indexOf(ANCHOR)
  if (at === -1) {
    throw new Error(
      'dsh-base: llm-deepseek entry not found; vendor layout changed, update patches/dsh-base/llm-retry-policy.cjs'
    )
  }
  const after = source.slice(at + ANCHOR.length)
  if (/^\r?\n[ ]+config:/.test(after)) {
    throw new Error(
      'dsh-base: the llm-deepseek entry already carries a config block; merge patches/dsh-base/llm-retry-policy.cjs by hand'
    )
  }
  return source.slice(0, at + ANCHOR.length) + '\n' + BLOCK + after
}
