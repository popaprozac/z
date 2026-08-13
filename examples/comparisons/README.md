# Cross-language comparisons

These examples compare Z with other languages on the same concrete task. They
are developer-experience studies, not benchmarks or claims that one language is
universally better. Each comparison should:

- preserve equivalent observable behavior;
- show build, dependency, and native-link setup rather than hiding it;
- distinguish compiler features from generated bindings and wrapper libraries;
- keep safety, ownership, cleanup, and unchecked operations visible; and
- count Z contracts or other reusable declaration work honestly.

Current comparison:

- [`sdl3`](sdl3): one interactive SDL3 application in Z, C, Zig, Nim, and
  raw-binding Rust.

Runtime performance comparisons live separately in [`../../benchmarks`](../../benchmarks)
and follow the equivalent-semantics methodology in
[`../../docs/performance.md`](../../docs/performance.md).
