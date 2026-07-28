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

The resulting compilation path does not execute Bun or TypeScript. The current
command is intentionally smaller than the production `z` CLI:

```text
z-native check <entry.zs>
z-native emit <entry.zs> <output.c>
z-native build <entry.zs> <output> [--release]
z-native run <entry.zs> <output> [--release] [-- args...]
```

It supports the self-hosting language and runtime subset. The native driver
finds the nearest `z.json`, parses the existing target entry, deployment,
include-directory, link-directory, and library fields, validates configured
paths, deduplicates native libraries, and projects those settings into Clang.
Swift target preparation, foreign header discovery, cross-platform target
selection, custom profiles, polished diagnostics, automatic temporary output
selection for `run`, and the complete production command options remain with
Stage 0 until equivalent native paths are proven. The current debug profile
uses Clang `-O0`; `--release` uses `-O2 -DNDEBUG`.

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
native `z.json` settings. This is a recursive compiler fixed point;
distributing a trusted bootstrap binary and replacing the broader production
CLI are separate release steps.
