# C Export Design

Status: scalar functions, owned UTF-8 `String` inputs, checked by-value C-layout
structs, and fixed-representation C enums implemented in both the Stage-0 and
fixed-point native compilers. Project-built libraries also publish a
target-scoped runtime lifecycle and enter it around every public call.

This note defines the first direction for calling Z from C-family consumers.
It complements header-first native imports: importing a header brings native
code into Z, while a C export publishes a checked Z implementation through a
stable native ABI.

## Source boundary

An ordinary export is visible to other Z modules:

```z
export function add(left: i32, right: i32): i32 {
  return left + right;
}
```

A C export additionally publishes a C ABI symbol:

```z
export c function z_math_add(left: i32, right: i32): i32 {
  return left + right;
}
```

`c` is contextual at a native ABI declaration; it does not reserve ordinary
bindings named `c`. The source function name is initially the exact public C symbol. C APIs
normally prefix global symbols, and requiring that spelling keeps the first
tier explicit without adding ABI-alias grammar prematurely. A project that
wants a different internal name can use a boundary wrapper:

```z
function add(left: i32, right: i32): i32 {
  return left + right;
}

export c function z_math_add(left: i32, right: i32): i32 {
  return add(left, right);
}
```

Two C exports with the same symbol are an error across the complete linked
module graph. They are not silently module-mangled because their names are an
external ABI contract.

Z package visibility and native ABI visibility are separate contracts.
`internal` has no C equivalent, and `internal c function` is rejected: a C
entry point must be declared explicitly with `export c function`. Generated
consumer headers omit internal functions, constants, constructors, and
members. An exported C wrapper may call internal Z code, so a library can keep
its implementation package-private while publishing a narrow checked ABI.

This boundary is encapsulation rather than a security sandbox. Shared-library
builds hide compiler-owned implementation symbols by default, and all symbols
outside the generated header are unsupported and unstable. A non-exported
`c struct` or `c enum` that occurs in a public C signature is necessarily
emitted into the header because the consumer must be able to express that ABI;
doing so does not make the declaration part of the public Z package surface.

`export c function` is preferred over:

- treating every Z module export as a native symbol;
- `extern`, which conventionally describes an implementation supplied
  elsewhere;
- comments or decorators that sit outside ordinary semantic checking;
- a manifest list separated from the declaration it exposes; or
- `as c`, because TypeScript-shaped `as` does not perform conversion or create
  linkage.

## Scalar ABI tier

The first executable slice accepts only types with an unambiguous scalar C ABI:

| Z | Generated C |
| --- | --- |
| `i8`, `i16`, `i32`, `i64` | `int8_t`, `int16_t`, `int32_t`, `int64_t` |
| `u8`, `u16`, `u32`, `u64` | `uint8_t`, `uint16_t`, `uint32_t`, `uint64_t` |
| `isize`, `usize` | `intptr_t`, `uintptr_t` |
| `f32`, `f64` | `float`, `double` |
| `boolean` | `bool` |
| `void` | `void` |

The boundary still rejects `String` results, collections, slices, nullable
values, ordinary Z structs and enums, classes, closures, generic functions,
typed errors, async functions, and executor-affine functions. Owned `String`
inputs plus checked `c struct` and `c enum` values are the deliberate
exceptions described below. A targeted diagnostic must name the unsupported
boundary type or effect rather than letting generated C fail.

The initial proof uses ordinary by-value scalar parameters. Mapping `in`,
`inout`, and `out` onto a public pointer ABI is an explicit follow-up design
decision; the compiler must not silently reinterpret those capabilities.

This narrow start is deliberate. Z-owned values must never escape through an
accidental layout, and a C caller cannot be assumed to understand Z cleanup,
ARC, task, or error representations.

## Owned UTF-8 String inputs

An owned Z `String` parameter deliberately projects to a borrowed C string at
the public ABI:

```z
export c function z_message_length(message: String): usize {
  return message.byteLength;
}
```

```c
Z_API uintptr_t z_message_length(const char *message);
```

The generated wrapper requires a non-null, NUL-terminated, valid UTF-8 input,
copies it once into owned Z storage, and transfers that owner to the ordinary Z
implementation. The implementation's normal parameter cleanup destroys the
copy on every return path. Invalid input terminates at the boundary just as an
unknown fixed-representation enum value does; it never becomes an invalid Z
value.

This mapping applies only to C calls. An ordinary Z caller invokes the same
function with a `String` and does not cross the public wrapper or make the
boundary copy. Returning `String` to C remains unsupported until the ABI can
name an allocator and ownership/release contract. A later `cstring` parameter
tier will provide zero-copy synchronous access with an enforced non-escaping
lifetime.

## C-layout structs

`c struct` is a representation contract independent from ordinary Z module
visibility:

```z
c struct ZMathPoint {
  x: i32;
  y: i32;
}

export c function z_math_translate(
  point: ZMathPoint,
  dx: i32,
  dy: i32
): ZMathPoint {
  return ZMathPoint({
    x: point.x + dx,
    y: point.y + dy,
  });
}
```

The generated header contains the reachable value type and exact public
function signature:

```c
typedef struct ZMathPoint {
  int32_t x;
  int32_t y;
} ZMathPoint;

Z_API ZMathPoint z_math_translate(
  ZMathPoint point,
  int32_t dx,
  int32_t dy
);
```

`export c struct` composes ordinary Z module export with the same C layout
contract. Header generation follows reachability from C-exported function
signatures, so an internal `c struct` can still define a public function's ABI
without becoming a general Z module export.

The first struct tier permits public mutable fields containing fixed-width
scalars or other `c struct` values. It rejects empty and generic structs,
classes, private or readonly fields, traits, executor affinity, constructors,
and `deinit`. These restrictions prevent the C representation from bypassing
an invariant or cleanup obligation that the header cannot express. Methods do
not affect layout and remain Z-only.

## Fixed-representation C enums

`c enum` keeps Z's nominal enum and exhaustive-match semantics while fixing its
public scalar representation:

```z
c enum ZMathStatus: i32 {
  negative,
  zero,
  positive,
}

export c function z_math_classify(value: i32): ZMathStatus {
  if (value < 0) return ZMathStatus.negative;
  if (value == 0) return ZMathStatus.zero;
  return ZMathStatus.positive;
}

export c function z_math_status_code(status: ZMathStatus): i32 {
  return match (status) {
    negative => -1;
    zero => 0;
    positive => 1;
  };
}
```

The generated header uses the declared fixed-width integer and sequential
constants:

```c
typedef int32_t ZMathStatus;
#define ZMathStatus_negative ((ZMathStatus)0)
#define ZMathStatus_zero ((ZMathStatus)1)
#define ZMathStatus_positive ((ZMathStatus)2)
```

The first tier requires an integer representation, at least one payload-free
variant, and valid C identifiers. Explicit discriminants are a later extension.
A C caller can manufacture any integer, so every exported function accepting a
`c enum` validates the input before it enters ordinary safe Z. An unknown value
traps at that boundary rather than making an exhaustive Z match unsound.

## Generated interface

The backend keeps Z's implementation identity private and emits a public
wrapper:

```c
static int32_t Z_internal_z_math_add(int32_t left, int32_t right) {
    return left + right;
}

Z_API int32_t z_math_add(int32_t left, int32_t right) {
    Z_ForeignThreadEntry entry = z_embedded_runtime_zmath_enter();
    int32_t result = Z_internal_z_math_add(left, right);
    z_embedded_runtime_zmath_leave(entry);
    return result;
}
```

The wrapper separates the permanent public ABI from compiler-owned internal
names and calling conventions. Release-code inspection must verify that Clang
inlines the private implementation call when its semantics permit it. Project
library artifacts retain the bounded runtime entry shown above; ordinary
Z-to-Z calls target the private implementation directly and do not pay that
foreign-boundary accounting.

Z also emits a header:

```c
#pragma once
#include <stdbool.h>
#include <stdint.h>

#ifndef Z_API
#define Z_API
#endif

#if defined(__cplusplus)
extern "C" {
#endif

Z_API int32_t z_math_add(int32_t left, int32_t right);

#if defined(__cplusplus)
}
#endif
```

`Z_API` expands to the target's required import/export visibility. The
`extern "C"` guard makes the same artifact directly consumable by C++ and
Objective-C++; ordinary C importing also makes the first tier available to
Swift without implementing the Swift ABI.

## Artifacts

Library output is project configuration rather than declaration syntax. Static
and shared libraries use the same source-level ABI contract:

```json
{
  "target": {
    "kind": "static-library",
    "name": "zmath",
    "entry": "src/library.zs"
  }
}
```

With `z` on `PATH`, build from the project directory:

```sh
cd path/to/project
z build .
z build . --release
```

The repository Stage-0 wrapper runs from the package root, so its equivalent is:

```sh
bun run z build path/to/project
bun run z build path/to/project --release
```

The first command produces a debuggable library. `--release` selects optimized
code. The public artifacts are:

```text
build/libzmath.a
build/zmath.h
```

On Windows the archive uses `zmath.lib`. Compiler-owned generated source and
object files remain under `.z-cache/build`; consumers do not need them.
Static- and shared-library entries are export-only module graphs and do not
require `function main()`. All manifest targets require `target.name` and
`target.entry`; omitting `target.kind` selects an executable instead. Project
`check` accepts every target kind, while project `run` requires an executable.

See [`examples/interop/c/z-export`](../examples/interop/c/z-export) for a
complete Z library and handwritten strict-C consumer.

Changing the target kind to `"shared-library"` publishes the same header beside
the host-native dynamic artifact:

| Host | Shared artifact |
| --- | --- |
| macOS | `build/lib<name>.dylib` |
| Linux | `build/lib<name>.so` |
| Windows | `build/<name>.dll` |

[`examples/interop/c/z-shared-export`](../examples/interop/c/z-shared-export)
builds and runs the dynamic form. Versioned sonames/install names, installation
layout, and Windows import-library publication remain packaging work. An
inspectable project-level `z emit` prints the complete generated translation
unit selected by `target.entry` without writing an artifact. Header publication
remains part of `z build`; a separate header-emission command is not yet
defined. Executables remain the default target kind.

## Embedding lifecycle

A generated library is a process-owned Z runtime boundary, even when its first
exports contain only scalar arithmetic. The generated header therefore
publishes target-scoped lifecycle names derived from `target.name`. For a
target named `zmath`:

```c
zmath_runtime_status status = zmath_runtime_initialize(NULL);
if (status != ZMATH_RUNTIME_OK) return 1;

int32_t answer = z_math_add(20, 22);

if (zmath_runtime_shutdown() != ZMATH_RUNTIME_OK) return 2;
```

The host must initialize once before calling any exported Z function. A second
initialize reports `ZMATH_RUNTIME_ALREADY_INITIALIZED`. Shutdown is one-shot;
subsequent initialization or shutdown reports `ZMATH_RUNTIME_SHUT_DOWN`.

Every public wrapper enters the runtime through a lock-free active-call count,
then restores the caller thread's previous Z runtime route on exit. Calls from
multiple host-created threads are therefore ordinary supported entries, not
unregistered runtime access. The host still owns those threads and must join
them before unloading the library. If shutdown observes an active exported
call or escaping native callback before teardown begins, it reports
`ZMATH_RUNTIME_BUSY` and leaves the runtime callable. The host can join or
release that work and retry. Once shutdown queues an executor-bound runtime-root
finalizer, it instead reports `ZMATH_RUNTIME_DRAINING`. Admission is closed in
that state: the host must not call ordinary exports, must drain its executor
queue, and then retries shutdown to complete teardown. Separating these states
prevents `BUSY` from implying that root-owned state remains available after its
destruction has begun.

Calling an ordinary exported function before successful initialization, while
the runtime reports `DRAINING`, or after shutdown is an embedding-contract
violation and traps. An arbitrary exported function cannot report lifecycle
failure without changing its declared C return type, so only the generated
initialize and shutdown functions return runtime statuses. The same rule is
printed in every generated library header.

The optional configuration carries one deliberately narrow host hook:

```c
typedef struct zmath_runtime_config {
  void *context;
  zmath_runtime_enqueue_release enqueue_release;
  zmath_runtime_is_main_thread is_main_thread;
} zmath_runtime_config;
```

`enqueue_release` must arrange for `finalize(value)` to run exactly once on the
owning executor. Z wraps the work so shutdown remains draining until that finalizer
actually completes. The hook is not a general task scheduler. Headers define
`ZMATH_RUNTIME_REQUIRES_ENQUEUE_RELEASE` as `1` when the compiled library has
executor-bound class lifecycle; initialization then returns
`ZMATH_RUNTIME_INVALID_CONFIG` for a missing hook. Value-only libraries define
it as `0` and accept `NULL`. The hook may be called from any native thread and
must be thread-safe; its `context` must remain valid until shutdown succeeds.

`is_main_thread` proves that a host call is executing on the platform's main
thread. Headers define `ZMATH_RUNTIME_REQUIRES_MAIN_THREAD` as `1` when the
configured runtime owner or emitted class lifecycle is main-bound. Such a
library rejects a missing proof hook as invalid configuration and returns
`ZMATH_RUNTIME_WRONG_THREAD` when initialization is attempted elsewhere. Z also
checks that queued finalization actually arrives on main. This is a
thread-identity proof, not a scheduler; `enqueue_release` remains responsible
for delivering final cleanup.

Runtime entry has an intentional atomic accounting cost. Direct internal Z
calls still target the private implementation rather than re-entering through
the public wrapper, so the cost occurs only at the foreign boundary. A future
proven stateless export mode may omit it, but the default embedding contract
will not make safe shutdown depend on an undocumented host promise.

When a library uses the Objective-C backend, every public C wrapper also opens
an autorelease pool around the Z invocation. A host pthread therefore receives
the same temporary-object cleanup boundary as Z `main`; the embedding contract
does not rely on the foreign host having installed its own pool.

Libraries do not implicitly receive the host process's `argc`/`argv`.
`process.args()` and `process.executablePath()` are rejected in static and
shared-library targets for now. Hosts pass required argument or executable
information through an explicit exported function; a future runtime config
field may make that channel reusable without inventing ambient state.

### Owned runtime root

A library may opt into one explicit ownership-bearing root in `z.json`:

```json
{
  "target": {
    "kind": "static-library",
    "name": "zembed",
    "entry": "library.zs",
    "runtime": {
      "initialize": "initializeRuntime"
    }
  }
}
```

The named entry-module function returns the owner retained by the generated
runtime:

```z
import { Once, OnceLifetime } from "std/sync";
import { thread } from "std/thread";

class Application on thread.main {
  readonly name: String;

  deinit {
    // Library/application teardown.
  }
}

const application = Once<Application>();

function initializeRuntime(): OnceLifetime<Application> on thread.main {
  return application.initialize(new Application({ name: "Embedded" }));
}
```

`zembed_runtime_initialize()` calls this function and stores the returned
`OnceLifetime<Application>`. `zembed_runtime_shutdown()` destroys that same
owner after exported calls have left, so `Once` becomes unavailable and the
application's `deinit` runs exactly once. This is the intended way for a C-ABI
library to retain Z-owned services, registries, mutexes, callback connections,
or application identity across separate native calls. A Z struct can compose
several roots into the single returned owner.

An exported function may retrieve a published identity through `Once.get()`.
The generated wrapper has already entered the runtime, but ordinary Z access
rules still apply: an entered host worker can use unrestricted methods and
`Mutex<T>` state while main-only fields and methods remain compile-time errors.
Runtime entry establishes ownership context, not executor affinity.

The first tier requires a zero-argument, synchronous, non-throwing,
non-generic, ordinary Z function whose result needs cleanup. It cannot also be
`export c`. Main-bound returned storage requires the initializer itself to end
in `on thread.main`; the generated header then requires both host hooks above.
Native by-value resources are temporarily rejected as direct root fields until
placement construction lands; put them behind a Z class or owned native handle.

This remains explicit target initialization, not implicit import execution.
Z still has no module initialization order, module-level `let`, or arbitrary
startup side effects. Value-only libraries can omit `target.runtime` entirely.
The host must not re-enter a public Z export before initialization returns, and
must keep the configuration context alive until shutdown succeeds.

## Growth path

Broader exports should land only with an end-to-end C consumer:

1. ABI-stable scalar functions and static/shared-library header output.
2. Explicit C-layout structs and fixed-representation payload-free enums.
3. Borrowed strings and slices projected as pointer-plus-length inputs.
4. Typed `throws` projected into explicit status and output channels.
5. Owned results paired with generated destruction functions.
6. Callback exports with explicit context, ownership, and threading.
7. Async exports through completion callbacks or explicit task handles.

For binary-only Z consumption, the toolchain can eventually generate an
adjacent `.zd` beside the public header. The header remains ABI truth; the
generated declaration preserves ownership and error facts that C cannot encode:

```text
Z source
  ├─> generated header and library ─> C, C++, Objective-C, Swift
  └─> generated adjacent .zd       ─> checked binary-only Z import
```

The current value-ABI checkpoint is complete only when handwritten C programs
include the generated header, link the generated static and shared libraries,
initialize their target-scoped runtime, pass supported values in both
directions from the host thread and host-created worker threads, shut down, and
pass strict compilation and execution tests.

The bootstrap compiler now satisfies that executable boundary in both its test
suite and the readable example: it parses and checks `export c function`, keeps
the declaration available through ordinary Z imports and calls, emits a private
implementation plus exact public C symbol, generates the guarded header,
builds the selected library artifact through `z build`, and runs handwritten
strict-C consumers. The accepted `static-library` and `shared-library` manifest
kinds make `main` optional and select the public artifact form.

The native semantic graph carries the C-export fact and checks it during hybrid
parity. Native lowering emits the same private-implementation/public-wrapper
shape and guarded header, and the standalone fixed-point `z` accepts the same
project-library command:

```sh
cd examples/interop/c/z-export
../../../../.z-cache/bootstrap/z build .
```

The native archive and header pass the same handwritten C consumer unchanged,
including struct construction, enum constants, and an enum parameter validated
by the public wrapper. Broader ABI tiers and the remaining
bootstrap-distribution work are independent follow-ups rather than hidden
dependencies of value-oriented Z-to-C use.
