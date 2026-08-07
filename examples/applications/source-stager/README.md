# Source stager

This small tool-shaped example exercises the first self-hosting prerequisites:
owned program arguments, fallible file reads and writes, and direct child
process execution without a shell.

Run it from the repository root:

```sh
bun run z run examples/applications/source-stager/main.zs -- examples/language/basics/first.zs
```

The program copies the requested Z source into `.z-cache/self-host-input.zs`,
launches `clang --version`, and reports the compiler exit code. `std/fs`
operations and `process.run` use normal typed Z failure handling, so the example
materializes the outer result with `attempt` and handles both arms explicitly.

This application is not itself a compiler; it is an educational pressure test
for the APIs used by the self-hosted driver. Stage 0 and the fixed-point native
compiler lower their supported `std/fs` and `std/process` calls through native
runtime helpers. Portable standard-library behavior will move into `.zs`
modules while OS-specific file/process operations remain a small platform
substrate.
