---
title: Testing, projects, and the CLI
description: Keep tests beside code, configure native artifacts in z.json, and use one command surface from checking through release builds.
sidebar:
  order: 17
---

Z tests are declarations, not a separate source language. They may live beside
private implementation code or in dedicated `*.test.zs` modules.

```z
import { expect } from "std/test";

function add(left: i32, right: i32): i32 {
  return left + right;
}

test "add combines two values" {
  const answer = add(20, 22);
  expect(answer).toEqual(42);
}
```

The file suffix is an organizational convention. Production `build`, `run`,
and `emit` paths omit test bodies, names, and runner code wherever the test is
written.

## Expectations use ordinary Z semantics

```z
import { expect, fail } from "std/test";

test "an owned value can be inspected without moving it" {
  const status = "ready";
  expect(in status).toEqual("ready");

  if (status.byteLength == 0) {
    fail("status must not be empty");
  }
}
```

`expect(actual).toEqual(expected)` uses the same `==` semantics as ordinary Z;
it does not introduce implicit deep structural equality. Expectation operands
are borrowed for the statement. The explicit `in` above is valid but optional,
just as it is at an ordinary immutable-borrow call site.

Failures preserve deterministic cleanup and do not prevent later tests from
running. The current public runner supports synchronous tests; async tests and
reusable assertion helpers need later test-context support.

## Run reachable tests

```sh
z test path/to/module.zs
z test path/to/project
```

The runner discovers tests in the selected entry module's project-owned import
graph. A test target does not require `function main()`.

During repository bootstrap, use `bun run z test ...`. The fixed-point native
compiler exposes the same command as `z test ...`.

## Describe a project with `z.json`

An executable target needs a name and entry module:

```json
{
  "target": {
    "name": "notes",
    "entry": "main.zs"
  }
}
```

Omitting `kind` selects an executable. Library projects choose
`"static-library"` or `"shared-library"` and expose checked C entry points with
`export c function`.

Exact external Z modules can receive public import names at the project root:

```json
{
  "imports": {
    "zapp": "vendor/zapp/zapp.zs",
    "zapp/window": "vendor/zapp/zapp/window.zs"
  },
  "target": {
    "name": "notes",
    "entry": "main.zs"
  }
}
```

Both the compiler and editor then resolve `"zapp"` as checked Z source. Only
the exact listed names are public; package installation and version selection
remain future tooling over this local resolution primitive.

Native dependencies remain build configuration rather than source-level linker
directives:

```json
{
  "target": {
    "name": "notes",
    "entry": "main.zs",
    "platform": "macos",
    "minimumVersion": "14.0",
    "includeDirectories": ["vendor/include"],
    "link": {
      "directories": ["vendor/lib"],
      "libraries": ["sqlite3"],
      "frameworks": ["AppKit"]
    }
  }
}
```

Relative paths resolve from the manifest directory. The editor schema completes
and validates manifest fields; the compiler remains authoritative for path,
platform, availability, and ABI checks.

## One command surface

| Command | Purpose |
| --- | --- |
| `z check <input>` | Parse, type-check, and validate ownership |
| `z emit <input>` | Print generated C-family source for inspection |
| `z metadata <input>` | Produce checked versioned metadata for tools |
| `z build <project>` | Build the configured executable or library |
| `z run <input>` | Build and execute an executable |
| `z test <input>` | Discover, compile, and run reachable tests |

`<input>` may be a `.zs` entry, project directory, or `z.json` where the
command allows it. Add `--release` to `build` or `run` for an optimized native
build.

```sh
z check .
z run . --release
z build . --release
```

The repository currently uses `bun run z` as the trusted Stage-0 seed. Running
`bun run bootstrap` produces the local fixed-point native `z` binary with the
same user-facing command surface. A versioned compiler distribution remains
future release engineering.

:::note[Build transparency]
`z emit` is a first-class debugging tool. Z lowers to readable C-family source,
then invokes the platform native toolchain. Release performance should be
judged from `--release` output, not the deliberately debuggable default build.
:::

For compiler-development test tiers, timeouts, sanitizers, and CI organization,
see the maintained [testing reference](https://github.com/popaprozac/z/blob/main/docs/testing.md).

Next: [Native interop](/interop/).
