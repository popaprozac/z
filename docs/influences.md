# Influences and lineage

Z is an experimental language assembled from ideas with long and visible
histories. This document records that lineage explicitly. It is neither an
originality claim nor a claim that the named projects endorse Z.

Three distinctions matter:

- **Design influence** means a language, paper, or project helped shape a Z
  decision or supplied a useful precedent.
- **Convergent prior art** means another project explored a materially similar
  idea earlier, even if Z reached part of its design independently.
- **Implementation provenance** concerns copied or adapted source code. Design
  acknowledgement alone does not mean Z contains upstream implementation code;
  any such code must retain its own license and attribution in the repository.

## Primary influences

| Influence | What Z borrows or adapts | Where Z deliberately differs |
| --- | --- | --- |
| [TypeScript](https://www.typescriptlang.org/docs/handbook/intro.html) and JavaScript | Familiar module syntax, `const`/`let`, `function`, classes, generics, arrow closures, object construction and destructuring, spread, template interpolation, `async`/`await`, generators, `for...of`, `for await...of`, and `T \| null` spelling | Z is ahead-of-time native, nominal and layout-aware. It has no JavaScript object/prototype model, implicit garbage-collected runtime, `any`, truthiness-driven typing, structural trait conformance, or Promise semantics. Assignment is not an expression. |
| [BorrowScript](https://github.com/alshdavid-public/BorrowScript) | Clear prior art for the central proposition that a TypeScript-shaped language can expose borrow checking readably. Its public design uses binding mutability and keyword ownership operations including `read`, `write`, `move`, and `copy`; Z's readable `move value` and `copy value` surface belongs in that lineage. | Z uses `in`, `inout`, `out`, `move`, `copy`, and `view`; distinguishes value `struct` from ARC `class`; supports deterministic native resources, typed foreign contracts, and structured task/executor semantics; and does not aim to be TypeScript with only a minimally overlaid Rust checker. |
| [Rust](https://doc.rust-lang.org/book/ch04-00-understanding-ownership.html) | Compile-time ownership and borrowing, affine move-only resources, exclusive mutable access, deterministic destruction, ownership-aware closure capture, `Option`/`Result` ergonomics, tagged-enum matching, traits, and safe/unsafe boundaries | Ordinary Z APIs avoid explicit lifetime parameters. ARC classes and `Weak<T>` are first-class alongside uniquely owned values. Z spells capabilities as words at parameters and calls, and combines typed `throw`/`try` with materialized `Result` through `attempt`. Rust remains a safety and performance comparison, not Z's syntax template. |
| [Hylo](https://hylo-lang.org/introduction/) | Mutable value semantics as a design lens, [explicit access capabilities](https://hylo-lang.org/docs/user/language-tour/bindings/), exclusive access to mutation, non-hidden copies, in-place mutation, projections, and the ambition to keep ownership reasoning local without pervasive lifetime spelling | Z is a hybrid rather than a complete Hylo-style mutable-value-semantics system: it includes ARC identity, native handles, non-escaping `view`, and its own ownership/capability rules. Z does not claim Hylo's full access model or its formal properties. |
| [Swift](https://docs.swift.org/swift-book/documentation/the-swift-programming-language/automaticreferencecounting/) and Objective-C | Value types beside ARC reference identity, weak references, `deinit`, `inout`, typed `throws`/`try`, async functions, [structured tasks and main-actor isolation](https://docs.swift.org/swift-book/LanguageGuide/Concurrency.html), API availability, and practical application/platform interop | Z applies deterministic `deinit` to value resources as well as ARC identity, keeps native task/error representations its own, uses `on thread.main` rather than attributes, and imports Swift through generated public interfaces rather than claiming Swift ABI compatibility. |
| [Nim](https://nim-lang.org/docs/manual.html) | The ergonomic bar for calling C, C++, and Objective-C; C-family code generation as a practical native backend; destructors and move semantics; and the experience of [ARC plus ORC cycle handling](https://nim-lang.org/blog/2020/12/08/introducing-orc.html) | Z derives foreign declarations through Clang, keeps native headers as ABI truth, and uses `.zd` only for semantic facts missing from headers. ARC is limited to reference-identity classes rather than being Z's universal storage strategy; cycle collection remains future work rather than a completed guarantee. |
| [Zig](https://ziglang.org/documentation/master/) | Explicit-cost systems programming, inspectable native boundaries, inline `test "..." {}` precedent, release-safe performance comparison, and `comptime` as an area worth a deliberately small experiment | Z chooses TypeScript-shaped syntax, managed reference identity, typed structured async, and a Clang-derived interop model. General `comptime` is not currently an implemented language promise. |
| C and C++ | Native ABI vocabulary, value layout, direct calls, deterministic RAII-style resource management, and the practical platform/toolchain ecosystem Z targets | Safe Z does not expose unrestricted pointer arithmetic or unchecked aliasing. C++ inheritance and its implicit copy model are not Z's object model. Generated C-family source is a backend and inspection artifact, not the semantic definition of Z. |
| ML-family languages and their descendants | Algebraic data types, payload-carrying variants, exhaustive pattern matching, and the deeper lineage behind `Option<T>` and `Result<T, E>` | Z uses TypeScript-shaped declarations and a systems ownership model. Rust helped popularize these forms for contemporary systems programmers, but neither Rust nor Z originated algebraic data types or pattern matching. |

## Concrete surface lineage

| Z surface or idea | Main lineage | Z-specific adaptation |
| --- | --- | --- |
| `import { value } from "module"`, `export`, generics, arrow closures, destructuring, spread, template strings | TypeScript/JavaScript | Resolved statically with native types, ownership, and deterministic cleanup |
| `.zs` source plus `.zd` declarations | TypeScript [`.ts`/`.d.ts` declaration files](https://www.typescriptlang.org/docs/handbook/declaration-files/introduction); [Clang API Notes](https://clang.llvm.org/docs/APINotes.html) and Swift metadata concepts | The real native header remains ABI truth. `.zd` augments it with ownership, lifetime, error, callback, and threading facts rather than restating the whole ABI |
| `move value`, `copy value` | Rust ownership concepts; BorrowScript's keyword operations; move semantics across systems languages | Readable contextual expressions integrated with Z's cleanup and capability checker |
| `in value`, `inout value`, `out value`, `view value` | Hylo and Swift access vocabulary, C# and C-family parameter modes, Rust borrowing | Capability-first spelling at declaration and call sites; inferred lexical provenance without ordinary lifetime parameters |
| `struct`, ARC `class`, `Weak<T>`, `deinit` | Swift/Objective-C value/reference split, ARC, and weak semantics; Rust's explicit weak upgrade; C++/Rust deterministic cleanup; Nim ARC/destructors | ARC pays only for shared identity, while value resources retain deterministic exactly-once cleanup. `Weak<T>.upgrade()` makes promotion explicit and fallible |
| `return` for success, typed `throw`, `try`, and `attempt` | Swift-style typed error surface combined with Rust/ML-style explicit result values | A thrown error is a typed function outcome rather than an unchecked exception; `attempt` materializes `Result<T, E>` for local matching |
| Payload enums and exhaustive `match` | ML-family algebraic data types; Rust and Swift enums/pattern matching | TypeScript-shaped declarations, expression arms, and explicit consuming versus borrowing match modes |
| `async scope`, `TaskScope`, child `task`, join and cancellation | The broader structured-concurrency lineage, including Swift task groups and nursery-style systems | Executor placement, ownership capture contracts, deterministic child lifetime, and cancellation as a structural outcome are checked together |
| `on thread.main` | Swift `@MainActor`, Objective-C/AppKit thread affinity, and actor/executor research | Placement is part of Z type/effect evidence and composes with direct calls, tasks, fields, native metadata, and hover information |
| `thread.spawn` and scoped `Mutex<T>` / `Once<T>` APIs | Rust and Go synchronization/thread APIs plus scoped-access designs across systems libraries | Z separates an OS thread from a structured child `task`, makes ownership transfer explicit, and uses non-escaping closures for guarded access |
| `unsafe { ... }` and `raw c` / `raw cpp` / `raw objc` | Rust's explicit unsafe boundary; [Zen-C interop](https://docs.zenc-lang.org/tour/14-interop/) and embedded-native escape hatches | `unsafe` remains typed Z with local untrusted facts; `raw` exits Z's type system and requires explicit `using` boundary capabilities plus source-mapped diagnostics |
| `export c function` and generated headers | C ABI export facilities in Rust, Zig, Swift, and native toolchains | The function remains callable from Z while publishing a checked C symbol and generated consumer header |
| Top-level `test "name" {}` | Zig and Rust's language-aware inline testing traditions | Tests are ordinary Z declarations, erased from production builds, with expectations imported from `std/test` |

Some of these ideas have multiple independent histories. The table names the
lineages most directly relevant to Z's actual design discussions; it does not
award invention to the most recent language that popularized a feature.

## Research and adjacent projects

These projects inform open questions or serve as comparison points, but should
not be mistaken for implemented Z semantics:

- [Ante](https://antelang.org/blog/stable_mutable_refs/) and the analysis of
  [borrowing combined with reference counting](https://verdagon.dev/blog/ante-blending-borrowing-rc)
  motivated Z's local-uniqueness and shape-stability experiments. The first
  shipped slice adds no syntax: direct local ARC aliases carry identity evidence,
  so existing `inout` temporarily excludes a second alias from the same call and
  releases that restriction immediately when the synchronous call returns.
  The second slice extends the same `in`/`inout` spelling through disjoint,
  fixed-layout value-struct field paths and lets both semantic frontends
  distinguish a direct field view from safe sibling mutation. Both lower to
  ordinary addresses with no lifetime syntax or runtime checks. Flow-sensitive
  provenance through arbitrary calls, stored aliases, aggregate-hidden
  identities, dynamic indexing, and class-field projections remain
  experiments. Direct inline closure captures now participate in the same call
  loan set, closing the first callback-shaped exclusivity hole;
  the recursive compiler AST plus Zapp-state probes decide how far they should
  go.
  Cross-thread mutation still requires `Mutex<T>` or executor isolation because
  shape stability does not prevent data races.
- Structured-concurrency work across Swift, Kotlin, Trio, and related systems
  provides the conceptual basis for parent-owned child lifetime. Z's exact
  `async scope` and `TaskScope` APIs remain its own evolving composition.
- C3, Odin, Carbon, Mojo, Vale, and other contemporary native-language projects
  are useful design and performance comparisons. They are not listed as direct
  sources for a Z feature unless a concrete dependency is documented here.
- Go is a readability and deployment comparison and influenced discussion of
  simple concurrency APIs. Z intentionally separates structured `task` from
  `thread.spawn`, and has not adopted goroutine or channel semantics as its
  foundation.

## Deliberate synthesis, not semantic camouflage

TypeScript familiarity is intended to lower the cost of reading Z, not to hide
systems semantics. The compiler should make every important divergence visible
through types, contextual keywords, diagnostics, hover, and examples. In
particular:

- familiar `const`, `let`, classes, imports, and arrow syntax do not imply
  JavaScript mutability, identity, coercion, or allocation behavior;
- familiar `throw` does not imply an unchecked exception runtime;
- familiar `async` does not imply JavaScript Promise scheduling;
- Rust-like ownership does not imply Rust syntax or explicit lifetime parameters;
- Swift-like ARC and main isolation do not imply that every value is reference
  counted or that Z implements the Swift ABI;
- Nim-like native reach does not make unsupported native semantics silently safe.

When Z intentionally invents a composition or spelling—such as typed
`return`/`throw` with `attempt`, `select` for local value-producing blocks, or
header-derived ABI plus `.zd` semantic contracts—the claim is about the
combination and its ergonomics, not invention of the underlying ingredients.

## Maintaining this record

A language decision should update this document when it:

- adopts recognizable syntax or semantics from another project;
- converges on prior art discovered after the initial design;
- changes a deliberate divergence described above; or
- promotes research influence into an accepted or implemented guarantee.

Implementation status still belongs in
[`bootstrap-status.md`](bootstrap-status.md), and accepted semantics still
belong in [`language-reference.md`](language-reference.md). This document owns
credit, lineage, and the boundaries of comparison.
