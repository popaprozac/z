---
title: Getting started
description: Build the Z compiler and run your first native Z program.
---

Z is currently developed from its source repository. There is not yet a
versioned compiler distribution or package manager.

## Requirements

- [Bun](https://bun.sh/) 1.3.14, or the version named by the repository
- Clang available on `PATH`
- On macOS, Xcode Command Line Tools for Objective-C, AppKit, and Swift probes

Clone the repository, then confirm the toolchain:

```sh
git clone https://github.com/popaprozac/z.git
cd z
bun --version
clang --version
bun run test
```

## Your first program

Create `hello.zs`:

```z
import console from "std/console";

function main(): i32 {
  const answer = 20 + 22;
  console.log(`answer=${answer}`);
  return 0;
}
```

Run it through the Stage-0 CLI:

```sh
bun run z run hello.zs
```

`main` is required for an executable entry point and returns the native process
exit code. Export-only `.zs` files are valid modules and do not require `main`.

Z uses `.zs` for source and `.zd` for foreign declaration contracts. It does
not claim `.z`, which Unix tooling commonly recognizes as a compressed archive.

## Useful commands

| Command | Purpose |
| --- | --- |
| `bun run z check file.zs` | Parse, type-check, and validate ownership |
| `bun run z emit file.zs` | Print the generated C-family translation unit |
| `bun run z metadata path` | Print versioned checked metadata for tools and generators |
| `bun run z run file.zs` | Compile and execute a native binary |
| `bun run z run file.zs --release` | Build and run with optimization |
| `bun run z test path` | Run reachable inline Z tests |
| `bun run bootstrap` | Build the local native `z` compiler |

Once the bootstrapped `z` binary is on `PATH`, project commands become simply
`z check .`, `z run .`, and `z build .`.

Native dependencies belong in `z.json`. Portable libraries use
`target.link.libraries`; Apple executables can use
`target.link.frameworks` for checked names such as `AppKit` and `WebKit`
without adding a Swift subtarget or raw linker flags. Reusable source packages
carry their required header paths, libraries, and frameworks transitively under
`library.native`, so applications do not duplicate package implementation
details.

## Editor support

The repository includes a VS Code/Cursor extension with syntax highlighting,
hover, completion, diagnostics, and a schema for `z.json`. Z is pre-alpha, so
the extension is installed from the repository rather than a public marketplace.

For current bootstrap details, testing tiers, and editor installation, use the
[repository documentation](https://github.com/popaprozac/z/tree/main/docs).
