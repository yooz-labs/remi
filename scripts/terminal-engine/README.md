# Terminal engine source characterization

The manifest pins the exact upstream 6.0.0 source-map contents and three omitted const-enum/type modules from commit `f447274f430fd22513f6adbf9862d19524471c04`.
The installed published source map is the source of the runtime implementation; the supplementary source files retain their upstream copyright and MIT headers.

The original upstream BufferLine tests construct real BufferLine, CellData and AttributeData instances.
Only their framework imports change: Node strict assertions replace Chai assertions, and Bun supplies `describe` and `it`.
All 49 original cases remain, including color/protection/extended attributes, wide/combined cells, insertion/deletion, resize, cloning and copying.
The tests run in an owned child with a private temporary home and are reaped before cleanup.

The characterization was committed against the original engine before the production patch.

The derived build applies only the readable `lazy-attributes.patch` to `BufferLine.ts`.
Content stays dense; foreground and background planes allocate on first nonzero use.
This preserves styled, protected and extended cells while avoiding unused style arrays for the admitted monochrome model.
The generator verifies every input hash and the exact patched source hash, uses esbuild 0.27.0, preserves upstream copyright banners and emits canonical source-map paths.
The generated package entry leaves the published JavaScript and source maps unchanged as independent controls.

Run `bun run verify:terminal-engine` to reproduce the installed derived files without network access.
The actual installed model, both original and patched upstream buffer tests, and direct published-versus-installed engine behavior are tested separately.
The storage change adds no input, authority, transport capability or larger memory limit.
