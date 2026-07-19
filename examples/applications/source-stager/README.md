# Source stager

This small tool-shaped example exercises the first self-hosting prerequisites:
owned program arguments, fallible file reads and writes, and direct child
process execution without a shell.

Run it from the repository root:

```sh
bun run z run examples/applications/source-stager/main.z -- examples/language/basics/first.z
```

The program copies the requested Z source into `.z-cache/self-host-input.z`,
launches `clang --version`, and reports the compiler exit code. `std/fs`
operations and `process.run` use normal typed Z failure handling, so the example
materializes the outer result with `attempt` and handles both arms explicitly.

This is not yet a self-hosted compiler. The public APIs are the intended Z
surface; their stage-0 implementations are native runtime helpers emitted by
the TypeScript bootstrap compiler. Portable standard-library behavior will move
into `.z` modules while OS-specific file/process operations remain a small
platform substrate.
