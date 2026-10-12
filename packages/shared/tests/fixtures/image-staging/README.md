# Image staging wire fixtures

ADR 0041 preparation: nine exact shapes, all eleven refusal codes, raw malformed
frames, inclusive bounds and exact owned PNG/JPEG chunk reconstruction.
These fixtures demonstrate wire shape validation only. They are not transfer
receipts, image decoder acceptance, authorization, cleanup or Swift conformance.
No capability or production caller is enabled by this codec.

The independent input copies are the owned Remi icon and a JPEG encoding of its
pixels (jpeg-js 0.4.4, quality 85), retained from the earlier candidate corpus.
Neither the codec nor these fixture tests depends on the proof corpus directory.

| Input | Bytes | SHA-256 |
|---|---:|---|
| fixture.png | 4774 | 04b6b9bbbb1c3d4c4c2c43096c78427fd41a1fbf53af75c167a5f1d52983d71c |
| fixture.jpg | 36027 | bfc90c41fb8b9749da14f88e8761c404a9cc69f1521272ca4aecf760128b12ae |

Regenerate deterministically from the repository root with the installed project tools:

```sh
bun packages/shared/tests/fixtures/image-staging/generate.ts
bunx biome format --write packages/shared/tests/fixtures/image-staging/vectors.json
```

The second command uses the project's locked Biome 1.9.4 and is required to reproduce
the checked-in numeric-array formatting.
`positive` entries contain raw UTF-8 JSON and the expected decoded object;
`negative` entries contain raw strings or explicit invalid UTF-8 bytes.
JSON member order and whitespace need not be preserved by re-encoding.

The fixture document contains only Unicode scalar strings. Malformed incoming
UTF-8 uses explicit byte vectors; tests construct raw-string lone surrogates at runtime.
