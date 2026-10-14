# Accepted image insertion vectors

These independent ADR0042 expectations cover the two exact message shapes,
all nine valid outcome/code pairs, request-only ingress and guarded malformed
correlation. They grant no file, session or insertion authority. The public
message registry and advertised capability remain unchanged in this slice.

`generate.ts` imports no production codec or guard. Regenerate with Bun from
that file. There are 14 positive and 282 negative vectors. `raw` is the exact
JSON text, `bytes` is invalid UTF-8, and `units` is raw UTF-16 containing an
unpaired surrogate. Keep the latter as integers so the outer corpus remains
valid Unicode JSON for Foundation. Construct it only in a runtime that can
represent invalid UTF-16; runtimes whose strings require valid Unicode should
reject the invalid encoding instead of silently substituting a scalar.

Positive `expected` is the decoded message. Every vector also records the
expected request ingress result. Host results are never client requests.
Malformed correlation is only an existing-owner lookup hint, not authority.
The corpus includes exact 65536-byte input, multibyte byte overflow, duplicate
decoded keys, unknown/missing members, noncanonical encodings and invalid
outcome/code pairs. A separate pre-extraction hash pins all 503 existing staging
vectors so reusing the scalar guards cannot silently change that contract.

TypeScript source and compiled Bun controls exercise these fixtures. Loading
the outer JSON in Foundation proves fixture interchange only; the native
decoder must run its own conformance controls before native availability.
