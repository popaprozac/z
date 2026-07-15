# Z Lang

Z is an experimental native systems language with TypeScript-inspired syntax,
safe value semantics, deterministic cleanup, typed errors, and first-class
interop with C-family platform APIs.

The bootstrap compiler currently implements a deliberately small vertical
slice: imports, functions, local bindings, primitive expressions, structs with
methods, tagged enums, exhaustive statement and expression matches, typed
errors, deterministic struct cleanup, name resolution, static checking, and
readable C emission. Header imports use Clang's AST to type-check an initial
subset of C functions. The compiler has no third-party package dependencies and
runs directly on Bun.

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

Control flow uses familiar TypeScript-style conditions with statically checked
Boolean expressions. A non-void function must return on every reachable path:

```z
function classify(value: i32, enabled: bool): i32 {
  if (!enabled) {
    return 0;
  } else if (value >= 10 && value != 42) {
    return 1;
  } else {
    return 2;
  }
}
```

Owned structs can define an infallible compiler-controlled lifecycle hook:

```z
struct File {
  handle: c.FILE;

  deinit {
    c.fclose(this.handle);
  }
}
```

`deinit` runs exactly once in reverse declaration order on normal scope exit,
`return`, `throw`, and `try` propagation. Fields with cleanup are then destroyed
in reverse field order. Cleanup-bearing values move when assigned, passed to an
owned parameter, returned, or placed into an owning field. Their previous
location cannot be used afterward. Path-sensitive analysis rejects values that
may have moved along only some continuing control-flow paths, while generated
live flags ensure each runtime path still performs cleanup exactly once.

Imported opaque handles participate in the same ownership system when API
notes provide the facts missing from C headers:

```z
import stdio from "stdio.h";

const file = stdio.fopen("notes.txt", "w");
if (!file) {
  return 1;
}

stdio.fputs("owned by Z\n", file);
// fclose(file) is inserted on every exit.
```

The truthiness guard narrows nullable `FILE *` to non-null. `fputs` borrows the
handle for the call; an explicit `fclose(file)` consumes it and makes any later
use a compile-time error. If ownership remains local, generated cleanup calls
`fclose` once and only when the handle is non-null.

Complete C records, enums, constants, and scalar typedefs are imported under the
module namespace and used with ordinary Z syntax:

```z
import geometry from "geometry.h";

function move(point: geometry.Point, amount: geometry.Count): geometry.Point {
  return geometry.translate(point, geometry.Forward, amount);
}

const origin = geometry.Point { x: 10, y: 20 };
const moved = move(origin, 3);
console.log(`moved to {moved.x}, {moved.y}`);
```

The header remains the single ABI declaration. Z checks record fields, enum
arguments, qualified signatures, and imported calls without an `extern` mirror.
The interpolated `console.log` line shows the planned formatting syntax; that
standard-library feature is not implemented in the bootstrap yet.

`try` evaluates its call once, propagates failure immediately, and produces the
success payload. It is currently supported directly in bindings, returns, and
expression statements; general nested-expression lowering comes later.

```sh
bun run z check examples/first.z
bun run z emit examples/first.z
bun run z run examples/first.z
bun run z run examples/control-flow.z
bun run z run examples/deinit.z
bun run z run examples/foreign-handle.z
bun run z run examples/foreign-types.z
bun run z run examples/structs.z
bun run z run examples/match.z
bun run z run examples/match-expression.z
bun run z run examples/result.z
bun run z run examples/try.z
bun test
```

The current header importer asks Clang for function declarations, rejects
unknown symbols, checks fixed argument types and counts, enforces variadic
boundaries, and carries supported return types into Z inference. Signed and
unsigned C integer spellings and common fixed-width or pointer-sized typedefs
map to Z's `i8` through `i64`, `u8` through `u64`, `isize`, and `usize` families;
`_Bool`, `const char *`, and `void` map to `bool`, `cstring`, and `void`. The
importer also accepts opaque single-pointer handles when API
notes specify nullability, owned returns and their release function, and
borrowed or consuming parameters. The compiler ships initial `stdio.h` notes
and discovers project notes beside a header as `<header>.zapi.json`; this JSON is
a stage-0 representation, not yet a frozen language format. Unannotated
pointers, borrowed returns without lifetime provenance, mutable strings,
globals, macros, Objective-C, and C++ remain conservative errors or future
layers rather than being silently treated as safe.

Complete typedef-named C structs with supported integer, enum, or nested-record
fields, C enums and their constants, and integer typedefs are now usable as
namespaced Z types. Integer literals are contextually typed and rejected when
they do not fit the destination width. Unions, anonymous or incomplete layouts,
plain `char` signedness, arrays, floating-point types, bitfield-specific
validation, callbacks, and pointer-bearing records remain upcoming interop
layers.

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
