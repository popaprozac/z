# Z Lang

Z is an experimental native systems language with TypeScript-inspired syntax,
safe value semantics, deterministic cleanup, typed errors, and first-class
interop with C-family platform APIs.

The bootstrap compiler currently implements a deliberately small vertical
slice: imports, functions, local bindings, primitive expressions, structs with
methods, tagged enums, exhaustive statement and expression matches, typed
errors, name resolution, static checking, and readable C emission. It has no
third-party dependencies and runs directly on Bun.

```z
import stdio from "stdio.h";

function add(a: i32, b: i32): i32 {
  return a + b;
}

function main(): i32 {
  const answer: i32 = add(20, 22);
  stdio.printf("Z says %d\n", answer);
  return 0;
}
```

Structs are value types with fields, literals, and methods:

```z
struct Point {
  x: i32;
  y: i32;

  function translated(dx: i32, dy: i32): Point {
    return Point { x: this.x + dx, y: this.y + dy };
  }
}
```

Tagged enums carry typed payloads and are matched exhaustively:

```z
enum UserResult {
  success User,
  failure UserError,
}

match result {
  success user => show(user);
  failure error => showError(error);
}
```

`match` can produce a value. A concise arm provides its expression directly;
use `yield` when an arm needs multiple statements:

```z
const id: i32 = match result {
  success user => {
    log(user);
    yield user.id;
  }
  failure error => throw error;
};
```

Throwing functions use a compiler-provided `Result<T, E>` without constructor
ceremony:

```z
function findUser(id: i32): User throws UserError {
  return User { id: id };
}

const result = attempt findUser(42);
match result {
  success user => show(user);
  failure error => showError(error);
}
```

`return` constructs success and `throw` constructs failure. A throwing call must
be marked with `attempt` for inspection or `try` for propagation:

```z
function userId(id: i32): i32 throws UserError {
  const user = try findUser(id);
  return user.id;
}
```

`try` evaluates its call once, propagates failure immediately, and produces the
success payload. It is currently supported directly in bindings, returns, and
expression statements; general nested-expression lowering comes later.

```sh
bun run z check examples/first.z
bun run z emit examples/first.z
bun run z run examples/first.z
bun run z run examples/structs.z
bun run z run examples/match.z
bun run z run examples/match-expression.z
bun run z run examples/result.z
bun run z run examples/try.z
bun test
```

The current header import proves the intended source experience and delegates
foreign-symbol checking to Clang. Z declarations are checked before emission;
imported signatures are not yet known to Z. This is not yet the safe Clang-AST
importer described in the design documents.

See [DESIGN.md](DESIGN.md) for the language charter and roadmap.

## Editor support

The repository includes an initial VS Code-compatible syntax extension in
`editors/vscode`. It recognizes `.z` files, comments, strings, imports,
declarations, control-flow keywords, primitive types, and numbers. Semantic
highlighting and diagnostics will come from the compiler-backed language server.

Install it locally for VS Code and/or Cursor, then reload the editor window:

```sh
./scripts/install-editor-extension.sh
```

The installer creates a development symlink, so grammar updates only require an
editor reload.
