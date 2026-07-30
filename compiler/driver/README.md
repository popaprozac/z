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
z emit <entry.zs>
z emit <entry.zs> <output.c>                 # bootstrap compatibility
z build [project-directory | z.json] [--release]
z build <entry.zs> <output> [--release]
z run [entry.zs | project-directory | z.json] [--release] [-- args...]
```

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
Swift target preparation, broader foreign declaration records, cross-platform
target selection, custom profiles, polished diagnostics, cache eviction, and
the complete production command options remain with Stage 0
until equivalent native paths are proven. Versioned shared-library policy,
Windows import-library publication, and project-level source emission are not
implemented yet. `run` creates missing
project-local cache parents and retains its generated C and executable at
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
library cannot be found in those directories or more than one supported
spelling exists in the selected directory, reuse fails closed and the driver
reports a cache bypass. System-search-path libraries therefore conservatively
relink until target-aware toolchain resolution is modeled. The native frontend
still loads, checks, and emits the graph on a cache hit; incremental parse and
semantic reuse are a later layer. The current debug profile uses Clang `-O0`;
`--release` uses `-O2 -DNDEBUG`.

For the first function-only scalar/status tier, the driver discovers the same
adjacent or include-directory `.zd` shapes as Stage 0, prefers the packaged
`z-foreign-adapter` beside its own executable and otherwise searches `PATH`,
then decodes its versioned Clang declaration stream, normalizes the contract in
Z, and supplies only checked
callables to native semantic analysis. Artifacts live under the owning
project's `.z-cache/foreign`; their driver identity includes the importing
module, header, contract contents, include directories, and target settings.
The adapter metadata additionally hashes Clang's preprocessed header view, so a
cache hit skips the AST producer while changes in transitive headers invalidate
the evidence. A missing contract, missing adapter, malformed producer stream,
unsupported declaration category, or unimplemented contract fact fails at the
boundary. Version 3 of the producer stream also carries nominal enum evidence
and typed native constants, so symbolic scalar and enum-backed status facts are
verified against Clang evidence and lower as the header symbol rather than a
magic integer. Enum-backed errors retain their nominal imported type through
native sema, `Result<void, E>`, matching, and C emission; explicit integer
construction uses the producer-verified underlying type. Ordinary enum
parameters and producer-proven constants retain that identity across namespace
or selective imports and lower to their verified C spellings. C++,
Objective-C, Swift, records, callbacks, and richer `.zd` facts remain with
Stage 0 until their raw records and normalized FIIR cross together.
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
