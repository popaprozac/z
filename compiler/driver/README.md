# Native Z compiler driver

`main.zs` is the first standalone compiler command implemented in Z. Once
Stage 0 emits it and Clang builds it, the resulting executable:

1. reads an entry `.zs` file through `std/fs`;
2. canonicalizes module identity and discovers relative `.zs` imports
   recursively;
3. parses and resolves the complete module graph through the native frontend;
4. lowers that graph to readable C;
5. writes `<output>.c`; and
6. invokes Clang directly to produce `<output>`.

The resulting compilation path does not execute Bun or TypeScript. The
fixed-point bootstrap publishes this command under the public local name `z`;
its supported surface is:

```text
z check [entry.zs | project-directory | z.json]
z test [entry.zs | project-directory | z.json]
z emit [entry.zs | project-directory | z.json]
z emit <entry.zs> <output.c>                 # bootstrap compatibility
z metadata [entry.zs | project-directory | z.json]
z build [project-directory | z.json] [--release]
z build <entry.zs> <output> [--release]
z run [entry.zs | project-directory | z.json] [--release] [-- args...]
```

`metadata` emits versioned compiler-owned JSON for tools that need checked
public symbols and resolved public call sites. Literal call arguments remain
literal evidence, while non-literals retain only their checked Z type. The
artifact is framework-neutral: consumers such as Zapp interpret their own
public builder calls without teaching the Z compiler about services or scanning
source text.

This is still narrower than the Stage-0 compiler in language and foreign
coverage even though it already has a more artifact-oriented command surface.
The native driver finds the nearest `z.json`, requires a portable target name
and `.zs` entry, and parses its kind, deployment, include-directory,
link-directory, and library fields. Project-directory `check`, `test`, `run`,
and `build` select that entry; an explicit `.zs` file overrides entry selection
while retaining its surrounding project settings. Omitted kind means
executable, while static- and shared-library builds publish their named native
artifact and generated header. The driver validates configured paths,
deduplicates native libraries,
and projects those settings into Clang.
Native Objective-C subclass checks also receive that deployment context:
unavailable declarations, APIs introduced after the configured minimum version,
and APIs removed at or before it are rejected before emission. When no platform
is configured, the driver supplies its host platform, but never invents a minimum
OS version. Deprecation warnings and remaining native availability composition
are separate parity work; native subclass execution remains gated.
Swift target preparation, broader foreign declaration records, cross-platform
target selection, custom profiles, polished diagnostics, cache eviction, and
the complete production command options remain with Stage 0
until equivalent native paths are proven. Versioned shared-library policy,
Windows import-library publication, and header-only emission are not
implemented yet. Project `emit` prints its selected complete translation unit
without writing artifacts. `run` creates missing project-local cache parents
and retains its generated C and executable at
`.z-cache/run/program.c` and `.z-cache/run/program`. An unchanged run compares
the exact newly emitted C, debug/release profile, target configuration, Clang
predefined-macro identity, and foreign producer evidence, then skips Clang and
reports a cache hit. The exact C comparison deliberately avoids a weak
source-hash collision. A move-only filesystem lock serializes inspection and
rebuild. Misses compile into pending paths; successful builds atomically publish
the C and executable before committing metadata. A failed compilation preserves
the previous executable but leaves metadata invalid, so it cannot become a
false cache hit.

`test` discovers top-level tests in the selected entry module and its
project-owned import graph, lowers `std/test` expectations and explicit
failures into one cleanup-preserving native runner, and keeps running after a failed
test. It returns a nonzero status when any test fails. Ordinary `emit`, `build`,
and `run` continue to erase test declarations and test-only helper machinery.

For each configured native library, the driver searches the explicit link
directories in order for the platform spellings it already passes to Clang. An
exactly resolved archive, import library, or dynamic library contributes its
canonical path and SHA-256 digest to the executable identity. The digest is
implemented in ordinary Z over `fs.readBytes`, and a regression proves that
unchanged archive bytes hit while rebuilding the archive invalidates. If a
library has multiple supported spellings in the selected directory, reuse
fails closed and the driver reports a cache bypass. A library left to the
system/toolchain search path contributes its logical linker name alongside the
Clang target identity; a failed link never publishes reusable metadata.

Project `build` has an earlier cache boundary than `run`. After resolving only
the entry, manifest, generated overlay, profile, and target identity, it checks
an atomic input record before loading or checking the module graph. That record
hashes the compiler executable, every reachable Z source and manifest, the
generated overlay, explicitly resolved native libraries, and the complete
transitive header and adjacent `.zd` dependency set reported by the foreign
adapter. A valid record with all expected output artifacts returns immediately;
changing any recorded input performs the complete build and replaces the record
only after successful publication. This is whole-project reuse rather than
incremental compilation: a changed source still reloads and rebuilds the graph.
The current debug profile uses Clang `-O0`; `--release` uses `-O2 -DNDEBUG`.

For the first function-only scalar/status tier, the driver discovers the same
optional adjacent or include-directory `.zd` shapes as Stage 0, prefers the
packaged `z-foreign-adapter` beside its own executable and otherwise searches `PATH`,
then decodes its versioned Clang declaration stream. Header-derived types,
constants, records, plain value-ABI functions, and Objective-C declarations
remain usable without an empty sidecar; when a `.zd` is present the driver
normalizes its extra facts in Z. The driver supplies only checked callables to
native semantic analysis. Artifacts live under the owning
project's `.z-cache/foreign`; their driver identity includes the importing
module, header, contract contents, include directories, and target settings.
The adapter metadata additionally hashes Clang's preprocessed header view, so a
cache hit skips the AST producer while changes in transitive headers invalidate
the evidence. A missing adapter, malformed producer stream, unsupported
declaration category, or unimplemented contract fact fails at the boundary. An
absent `.zd` fails only when source uses a C function whose pointer, ownership,
error, or other semantics prevent safe inference. Version 6 of the producer
stream carries scalar typedef evidence,
nominal enums, typed native constants, record layouts/fields, and canonical C
record identity across typedef aliases. Symbolic scalar and
enum-backed status facts are verified against Clang evidence and lower as the
header symbol rather than a magic integer. Enum-backed errors retain their
nominal imported type through native sema, `Result<void, E>`, matching, and C
emission; explicit integer construction uses the producer-verified underlying
type. Ordinary enum parameters and producer-proven constants retain that
identity across namespace or selective imports and lower to their verified C
spellings. Plain recursively copyable C structs cross by value in
parameters/results and through existing `.zd` `in`, `inout`, and `out` pointer
contracts with direct native construction, field access, and calls. The first
ownership-bearing record tier also accepts `export type T { move; deinit
release; }`, verifies the release signature against canonical Clang identity,
and requires resource producers to declare `owned;` or non-escaping
`borrowed;`. Z semantic borrows remain distinct from the C ABI mode, so
`in resource` can lower as a direct by-value call while preserving the caller's
owner. The owned pointer tier also accepts direct `T * | null` producers and
nullable `out T**` outputs whose blocks declare `deinit release;`; it verifies
the release signature, keeps `in` and `move` as direct pointer ABI calls,
zero-initializes output storage, destroys partially produced values before a
typed status propagates, narrows explicit null guards, and lowers
`Option.fromNullable` without repeating the native producer call. A
`borrowed;` pointer result becomes a nullable local view:
it receives no cleanup and cannot escape or become owned `Option` storage. C++,
Objective-C, Swift, unions, callbacks, owner-tied borrowed provenance, and richer
`.zd` facts remain with Stage 0 until their raw records and
normalized FIIR cross together.
Foreign-cache locking and cache eviction remain toolchain hardening.

`check` accepts an export-only entry module. `emit`, `build`, and `run` require
`function main(): i32`; a present but incompatible `main` is rejected by every
command before native emission. Lexer, parser, and semantic failures render
their canonical Z path, line and column, source line, and caret without
round-tripping through Stage 0.

The bootstrap regression first emits this driver through the trusted Stage-0
seed, then asks that native executable to build `main.zs` again. The
driver-generated C must match the seed-generated C byte for byte, and the
second-generation executable must compile an independent multi-module project.
The same integration builds a temporary static C library and links it through
native `z.json` settings. `bun run bootstrap` packages the resulting native
`z`, its inspectable generated C, and the standalone foreign adapter together.
This is a recursive compiler fixed point; signing, versioning, and distributing
trusted platform artifacts and replacing the broader production CLI are
separate release steps.
