# Z Lang

Z is an experimental native systems language with TypeScript-inspired syntax,
safe value semantics, deterministic cleanup, typed errors, and first-class
interop with C-family platform APIs.

The bootstrap compiler currently implements a deliberately small vertical
slice: imports, functions, local bindings, primitive expressions, structs with
methods, tagged enums, exhaustive statement and expression matches, typed
errors, deterministic struct cleanup, name resolution, static checking, and
readable native-source emission. Header imports use Clang's AST to type-check
an initial subset of C and Objective-C APIs. The compiler has no third-party
package dependencies and runs directly on Bun.

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

Large headers can expose only the C declarations a file uses, with optional local
aliases:

```z
import { sqlite3_open, sqlite3_close as closeDatabase } from "sqlite3.h";
```

This is a scope filter over the same typed header module, not a wrapper or an
ABI redeclaration. Functions, supported typedef-named types, and enum constants
share the same selective binding model.

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

Bindings make mutation explicit. `const` stores an immutable value; `let`
stores a mutable value in the same lexical scope. Z does not have JavaScript's
function-scoped, hoisted `var`:

```z
const origin = Point { x: 1, y: 2 };
let position = origin;
position.x = 10;
position = Point { x: position.x, y: 20 };
```

Assignment is a statement rather than a value-producing expression. It is
statically type-checked, and nested field mutation must remain rooted in a
`let`. Owned and `in` parameters are immutable; `inout` parameters permit
mutation of the caller's explicitly borrowed storage. Match bindings remain
immutable in this bootstrap slice. Replacing cleanup-bearing storage evaluates
the new value first, destroys the old value exactly once, and then installs the
replacement. If evaluation exits with an error, ordinary scope cleanup remains
responsible for the old value.

Methods borrow `this` immutably by default. A method that changes its receiver
declares the non-default capability as a TypeScript-style receiver parameter:

```z
struct Counter {
  value: i32;

  function add(inout this, amount: i32): void {
    this.value = this.value + amount;
  }

  function current(): i32 {
    return this.value;
  }
}

let counter = Counter { value: 1 };
counter.add(2);
```

`counter.add` requires mutable addressable `let` storage. `current` may be
called through `const`, `let`, or a temporary. The receiver capability belongs
to the method signature; callers do not repeat `inout` because the receiver is
already explicit in member-call syntax.

A consuming method takes ownership with `move this`:

```z
struct Resource {
  handle: usize;

  function close(move this): void {
    // Ownership ends here; deinit performs the release on method exit.
  }

  deinit {
    native_close(this.handle);
  }
}

const resource = Resource { handle };
resource.close();
// `resource` has moved and cannot be used again.
```

The receiver is passed by value and owned by the method. A cleanup-bearing
receiver is destroyed exactly once on every exit unless the method returns or
forwards `this`. The owned receiver may be mutated. Calling a consuming method
on a copyable struct copies it, so the original remains usable. `move` is
contextual before `this`; functions and enum variants may still be named
`move`.

Native function parameters are owned/by-value by default. Copyable values copy;
cleanup-bearing values move. A function declares a borrow only when it does not
need ownership:

```z
function read(in counter: Counter): i32 {
  return counter.value;
}

function add(inout counter: Counter, amount: i32): void {
  counter.value = counter.value + amount;
}

const current = read(counter); // `in` is quiet at the call site.
add(inout counter, 2);         // Mutation is explicit.
```

Capabilities precede the binding because they describe how the declaration may
access storage; the annotation after `:` is always the value's type.

Borrowed parameters cannot be returned, stored into owning fields, or otherwise
moved. `inout` requires an initialized mutable binding and can be forwarded with
`inout parameter`. The bootstrap currently borrows stored expressions or
non-cleanup struct literals; general borrowed-temporary lowering comes later.
`out` starts write-only, must be initialized on every successful return path,
and becomes readable after definite assignment:

```z
function divide(value: i32, out quotient: i32, out remainder: i32): void {
  quotient = value / 2;
  remainder = value - quotient * 2;
}

let quotient: i32;
let remainder: i32;
divide(17, out quotient, out remainder);
```

Cleanup-bearing output storage becomes live only after initialization. Passing
an already-live value to `out` destroys its old value before the call. Throwing
native functions with `out` parameters remain deferred so failure does not
leave ambiguous output state. A call may share one value through multiple `in`
parameters, but overlapping writable, owned, and borrowed uses are rejected.

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

Pointer parameters to complete imported records remain safe when adjacent API
notes classify their call-only access. Read-only `const T *` parameters borrow a
stored value implicitly; writable `T *` parameters require mutable storage and
an explicit mode at the call site:

```z
let point: geometry.Point;
geometry.reset(out point);
geometry.offset(inout point, 3, 4);
const score = geometry.read(point); // `in` is implicit for const T *.
```

`in` promises no mutation or retention, `inout` requires initialized storage and
permits reading and mutation, and `out` fully initializes possibly uninitialized
storage. The compiler creates an address only for the duration of that call; Z
exposes no general address-of operator.

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
bun run z run examples/foreign-pointers.z
bun run z run examples/selective-import.z
bun run z run examples/selective-declarations.z
bun run z run examples/apple-groundwork.z
bun run z run examples/nswindow.z # macOS: opens a window and enters AppKit's event loop
bun run z run examples/structs.z
bun run z run examples/match.z
bun run z run examples/match-expression.z
bun run z run examples/mutation.z
bun run z run examples/mutable-methods.z
bun run z run examples/borrowed-parameters.z
bun run z run examples/result.z
bun run z run examples/try.z
bun test
```

The current header importer asks Clang for function declarations, rejects
unknown symbols, checks fixed argument types and counts, enforces variadic
boundaries, carries supported return types into Z inference, and supports both
namespace imports and selective function, type, and enum-constant imports with
aliases. Selective type aliases preserve the underlying C declaration identity
in signatures, literals, field access, and calls. Signed and
unsigned C integer spellings and common fixed-width or pointer-sized typedefs
map to Z's `i8` through `i64`, `u8` through `u64`, `isize`, and `usize` families;
`float` and `double` map to `f32` and `f64`; `_Bool`, `const char *`, and `void`
map to `bool`, `cstring`, and `void`. The
importer also accepts opaque single-pointer handles when API
notes specify nullability, owned returns and their release function, and
borrowed or consuming parameters. Pointer parameters to imported complete
records are accepted only when notes classify them as non-escaping `in`, `out`,
or `inout`; writable calls require explicit mutable storage. The compiler ships
initial `stdio.h` notes
and discovers project notes beside a header as `<header>.zapi.json`; this JSON is
a stage-0 representation, not yet a frozen language format. Unannotated
pointers, borrowed returns without lifetime provenance, mutable strings,
globals, macros, and C++ remain conservative errors or future
layers rather than being silently treated as safe.

On macOS, importing an installed framework header selects the Objective-C ARC
backend and carries the framework into the native link plan:

```z
import AppKit from "AppKit/AppKit.h";

const app = AppKit.NSApplication.sharedApplication;
const window = AppKit.NSWindow.alloc().initWithContentRect(
  AppKit.NSMakeRect(0.0, 0.0, 800.0, 600.0),
  styleMask: AppKit.NSWindowStyleMaskTitled | AppKit.NSWindowStyleMaskClosable,
  backing: AppKit.NSBackingStoreBuffered,
  defer: false
);
window.title = "Hello from Z";
window.makeKeyAndOrderFront(null);
app.run();
```

The bootstrap imports Objective-C interfaces, superclass method lookup, class
and instance methods, property getters and setters, `instancetype`, object
nullability, and C values used inside method signatures. Calls use a selector's
first component as the TypeScript-style method name. Positional calls resolve by
argument count; labeling every argument after the first selects the complete
Objective-C selector. Imported custom property accessors are honored. String
literals bridge contextually to `NSString` for compatible Objective-C method
parameters and properties while remaining `cstring` everywhere else. ARC owns
local object-reference retain/release behavior, and the generated `main` runs
inside an autorelease pool. Protocols, delegates, blocks, general Z `String`
bridging, lightweight generics, availability checking, and actor isolation
remain upcoming layers.

```z
import {
  ZPoint as Point,
  ZForward as forward,
  z_translate as translate
} from "geometry.h";

const origin = Point { x: 10, y: 20 };
const moved = translate(origin, forward, 3);
```

Complete typedef-named C structs with supported integer, enum, or nested-record
fields, C enums and their constants, and integer typedefs are now usable as
namespaced or selective Z types and values. Numeric literals are contextually
typed and rejected when they do not fit the destination width. Unions,
anonymous or incomplete layouts, plain `char` signedness, arrays,
bitfield-specific validation, callbacks, and pointers stored inside records
remain upcoming interop layers.

See [DESIGN.md](DESIGN.md) for the language charter and roadmap.

## Editor support

The repository includes a VS Code/Cursor extension in `editors/vscode`. Its
TextMate grammar recognizes `.z` syntax immediately, and it starts the Bun-based
compiler language server when a Z document opens. The initial language-server
slice provides:

- live compiler diagnostics with debounced document checking;
- completion for imported C/Objective-C namespaces;
- type-directed Z struct and Objective-C instance/class member completion;
- local-symbol completion and semantic highlighting for bindings, parameters,
  namespaces, types, functions, methods, and properties;
- selector-aware Objective-C method snippets and argument-label completion;
- hover types and signatures; and
- go-to-definition for declarations in the current Z source file.

The server and compiler share lexer, AST, imported Clang metadata, semantic
types, and diagnostics. AppKit completions therefore come from the installed SDK
rather than a generated editor-only binding database. Definition links into C,
Objective-C, and Swift headers require importer source-location metadata and are
the next definition layer.

Install it locally for VS Code and/or Cursor, then reload the editor window:

```sh
./scripts/install-editor-extension.sh
```

The installer creates a development symlink, so grammar and language-server
updates only require an editor reload. Bun must be available on the editor's
`PATH`; the extension also detects the standard `~/.bun/bin/bun` installation,
and the `z.bunPath` editor setting can select another executable. The language
server can also be started directly for another LSP client:

```sh
bun run lsp
```
