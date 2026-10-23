# Terminal engine source characterization

The manifest pins the exact upstream 6.0.0 source-map contents and three omitted const-enum/type modules from commit `f447274f430fd22513f6adbf9862d19524471c04`.
The installed published source map is the source of the runtime implementation; the supplementary source files retain their upstream copyright and MIT headers.

The original upstream BufferLine tests construct real BufferLine, CellData and AttributeData instances.
Only their framework imports change: Node strict assertions replace Chai assertions, and Bun supplies `describe` and `it`.
All 49 original cases remain, including color/protection/extended attributes, wide/combined cells, insertion/deletion, resize, cloning and copying.
The tests run in an owned child with a private temporary home and are reaped before cleanup.

This initial pin changes no production engine, dependency, input, authority or memory limit.
