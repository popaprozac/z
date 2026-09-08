# Z language reference

This document summarizes the accepted source-language semantics of Z. It is
about what Z code means, independent of which bootstrap compiler tiers currently
execute every shape. For rationale and unresolved design questions, see
[`DESIGN.md`](../DESIGN.md). For implementation coverage and temporary limits,
see [`bootstrap-status.md`](bootstrap-status.md).

## Declarations and modules

Z source uses explicit exports and TypeScript-shaped imports:

```z
// geometry.zs
export struct Point { x: i32; y: i32; }
export function sum(in point: Point): i32 { return point.x + point.y; }

// main.zs
import geometry from "./geometry.zs";
import { sum as total } from "./geometry.zs";
```

Relative `.zs` imports form a source-module graph. Native headers use the same
surface (`import C from "library.h"`) but bind declarations supplied by the
foreign interface rather than redeclaring their ABI.

A reusable Z source package declares its identity and library surface in
`z.json`:

```json
{
  "package": {
    "name": "zapp",
    "version": "0.1.0"
  },
  "library": {
    "entry": "src/zapp.zs",
    "exports": {
      "./window": "src/window.zs"
    }
  }
}
```

An application makes that surface available with one local dependency:

```json
{
  "dependencies": {
    "zapp": { "path": "../zapp" }
  },
  "target": {
    "name": "notes",
    "entry": "main.zs"
  }
}
```

This makes `import { Application } from "zapp";` an ordinary checked source
import in the compiler and editor. The library entry implicitly owns the root
specifier; `"./window"` becomes `"zapp/window"`. Resolution is exact and
fail-closed, package paths are relative to the manifest that declares them,
and transitive path dependencies are resolved in both Stage 0 and the native
driver. A library may also carry native include and link requirements through
`library.native`; those requirements compose transitively so consumers do not
repeat a package's implementation details. Registry installation and lockfiles
remain future work.

### Tool-generated modules

Code generators do not add transient paths to authored `z.json`. They may write
a versioned `.zbuild.json` overlay and supply it to one project invocation:

```sh
z check . --generated .zapp/generated/services.zbuild.json
z build . --release --generated .zapp/generated/services.zbuild.json
```

```json
{
  "schemaVersion": 1,
  "modules": {
    "zapp/generated/services": {
      "source": "service-dispatchers.zs",
      "package": "zapp"
    }
  },
  "callAdapters": [{
    "source": "../application/main.zs",
    "sourceHash": "<lowercase SHA-256>",
    "offset": 144,
    "target": "ApplicationServicesBuilder.register",
    "replacement": "ApplicationServicesBuilder.registerGenerated",
    "argument": 1,
    "adapter": {
      "module": "zapp/generated/services",
      "export": "adaptNotesService"
    }
  }]
}
```

Module paths are relative to the overlay. Specifiers are exact, bare, and
cannot shadow `std` or any project/package import. The optional `package` must
name an existing package in the resolved graph; it grants the generated module
that exact package identity for `internal` access. Generated source receives no
other privilege and is parsed, checked, and lowered as ordinary Z.

Stage 0 also executes versioned, source-hashed `callAdapters` for tools that
need checked generated adapters without rewriting source. `offset` is the
parser's call-expression offset and `argument` is zero-based. Before adapting,
the compiler checks the source digest and proves that the call resolves to
`target`. The replacement must be a method on that same receiver type. The
selected argument is passed through the named generated function, then the
whole transformed AST is linked and checked normally in both compiler drivers.
When the adapter module is assigned an existing package, that package identity
may authorize an `internal` replacement method owned by the same package. The
grant applies only to the compiler-generated replacement access: it does not
make the member public, authorize authored calls, expose it through metadata or
completion, or bypass `private`. An adapter module without that package identity
remains an external caller and cannot select the internal method. Stale evidence,
a missing export, and an incompatible or unauthorized adapter or replacement
all fail closed at the authored call. The optional Stage-0 `--native-frontend` hybrid validation
mode still reports an explicit boundary because its in-process source-batch
protocol does not carry invocation overlays; the standalone fixed-point `z`
does execute the overlay itself. Generated overlays are build products, not
portable package configuration, and should normally live under a tool cache
such as `.zapp/`.

Modules may publish named compile-time values:

```z
// app-config.zs
export const APP_NAME: String = "Notes";
export const DEFAULT_PORT: u16 = 34115;
export const ENABLE_METRICS: boolean = true;

const CONFIG_REVISION = 1;
```

```z
import config from "./app-config.zs";
import { APP_NAME as appName } from "./app-config.zs";

function port(): u16 {
  return config.DEFAULT_PORT;
}
```

Module storage is immutable: Z has module-level `const`, not module-level
`let`. An exported constant requires an explicit type so its public contract
cannot change when its initializer is edited; a private constant may infer its
type. The first executable tier accepts cleanup-free literal `boolean`, numeric,
and `String` values, plus string literals explicitly typed `cstring`. Calls,
runtime initialization, and ownership-bearing module values remain outside this
tier, so importing a module does not run an initializer.

Package implementation APIs use `internal`:

```zs
// src/window-state.zs
internal struct WindowRecord {
  id: String;
}

export class WindowManager {
  internal function publish(inout this, in record: WindowRecord): void {
    // callable by sibling modules in this package
  }
}
```

Top-level `internal` declarations use ordinary imports from sibling modules but
cannot be imported by a dependent package. Internal fields and methods follow
the same rule. The owning `z.json` must declare `package.name`; directory
proximity alone never grants access. `internal` and `export` are mutually
exclusive, and package-internal names are omitted from public metadata and
external completion. Internal constructor signatures are omitted by the same
boundary even though their class remains usable as a public type. An internal
module constant requires an explicit type for
the same cross-module stability reason as an exported constant.

`internal` governs Z package visibility; it has no direct C spelling and is not
a native-code security boundary. A function cannot be both `internal` and
`export c`: only an explicit `export c function` becomes a supported C entry
point or appears in the generated consumer header. Public C wrappers may call
internal Z operations, which keeps implementation details behind the checked
ABI boundary. If a non-exported C-layout type is reachable through a public C
signature, its representation must still appear in the header so C can express
that ABI; this does not make the declaration importable by dependent Z
packages. Any non-header compiler-owned symbols are private, unstable
implementation details.

Invocation-scoped generated modules may be assigned an existing package in a
`.zbuild.json` overlay. That identity permits the generated module to import
the package's `internal` declarations. A checked call adapter may additionally
use the same identity for its one synthetic replacement-member access, allowing
framework generators to target an internal runtime operation without exposing
it to application source. This is a compiler-owned build capability, not syntax
that authored Z code can request.

### Explicit application-lifetime roots

`Once<T>` from `std/sync` provides a statically empty module root without
introducing module initialization order:

```z
import { Once, OnceState } from "std/sync";
import { thread } from "std/thread";

class Application on thread.main {
  readonly name: String;
}

const application = Once<Application>();

async function main(): i32 on thread.main {
  if (application.state() != OnceState.empty) return 1;
  const value = new Application({ name: "Notes" });
  const lifetime = application.initialize(move value);

  const same = application.get(); // Application
  return same.name == "Notes" ? 0 : 1;
} // lifetime removes the root and releases its strong ARC reference
```

`initialize(move value)` publishes exactly one strong ARC reference and returns a
move-only `OnceLifetime<T>`. That guard—not the module—owns the initialized
interval. Its deterministic cleanup empties the cell on the payload's executor.
`get()` returns `T`, retaining the class identity for the caller. It does not
return `Option<T>` or carry a hidden initialization error. Calling `get()` before
initialization or after guard cleanup, initializing twice, and cleaning up on
the wrong executor are rejected or trap as appropriate.
The two empty states have distinct invariant messages: a cell that has never
been initialized is reported separately from a publication lifetime that has
already closed. Reinitializing a closed cell remains invalid.
`OnceLifetime<T>` is exported from `std/sync` so a public startup wrapper may
name its return, but it has no user-callable constructor.

`state(): OnceState` takes the same synchronization boundary and reports one
payload-free lifecycle snapshot: `empty`, `initialized`, or `closed`. It does
not weaken the invariant-enforcing operations: `initialize()` and `get()` keep
their existing traps when called in an invalid state. A snapshot is useful for
diagnostics and for translating a serialized framework lifecycle into typed
errors. It is not a general check-then-act primitive because another thread may
change the cell after `state()` returns. Code that needs an atomic conditional
operation should use a purpose-built synchronized API rather than infer one
from the snapshot.

Repeated `get()` calls carry one canonical ARC identity into Z's synchronous
`in`/`inout` exclusivity checker. The same is true through a transparent
zero-argument accessor whose complete body is the direct return:

```z
export function currentApplication(): Application {
  return application.get();
}
```

This summary crosses source-module imports and requires no annotation. It does
not make the globally published identity locally contained: a class-field
`view` still requires a synthesized local `new` owner with no hidden aliases.
Functions with additional control flow or another return source are not
silently classified as transparent.

The value expression is evaluated before `initialize`:

```z
const value = try new Application(configuration);
const lifetime = application.initialize(move value);
```

If construction throws, ordinary `try`/`attempt` handles that error and the cell
remains empty. No failed value or error is published, so a later `get()` cannot
throw or replay the construction failure.

A nonthrowing temporary construction transfers directly without a redundant
`move`:

```z
const lifetime = application.initialize(
  new Application(configuration)
);
```

The first tier permits only ARC class payloads whose lifecycle belongs to
`thread.main`, either through a whole-class declaration or a main-bound field.
Construction, initialization, and guard cleanup require main-executor proof.
`get()` is synchronized and may run on any Z-managed thread; it retains and
returns the same identity without granting permission to use main-only members:

```z
const work = thread.spawn((): i32 => {
  const current = application.get();
  return current.snapshotRevision(); // unrestricted synchronized method
});
```

A worker may carry a whole-class-isolated identity opaquely and use it only
after explicit main placement. A mixed-affinity class can expose readonly
thread-safe metadata and synchronized methods directly while its main-only
fields and methods continue to produce `Z0711`. ARC retain is atomic, the cell
transition is mutex-protected, and a worker's final release is queued back to
the owning executor so `deinit` remains on main. Arbitrary foreign-created
threads will require an executor-registration contract before they receive the
same cleanup guarantee.

A value aggregate may store that ARC identity without inheriting its lifecycle
affinity merely from the reference field:

```z
struct RouteContext {
  application: Application;
  message: Message;
}
```

The context may be constructed, returned, and cleaned up on a registered
worker. Access through `context.application` still checks each `Application`
member: synchronized unrestricted methods remain available, while `window` or
another main-only member still produces `Z0711`. Directly stored AppKit values,
main-isolated value structs, and other inline executor-affine storage continue
to make the containing aggregate main-bound. Moving the complete context across
an OS-thread boundary remains subject to its ordinary whole-graph transfer
contract.

`get()` and lifetime cleanup are synchronized. If `get()` wins, its retained
identity remains valid after the module root is removed; if cleanup wins, the
later `get()` traps as a closed-lifetime access. Code must therefore join
workers that may retrieve the cell before allowing `OnceLifetime<T>` to leave
scope. This is an ordering contract, not a use-after-free race.

Ordinary mutable or readonly-shareable classes, structs, native resources,
replacement, optional storage, and concurrent weak upgrade are not implied by
this tier. `Application` is an example of a user-defined framework type, not a
language or standard-library global.

### Scoped shared mutation

`Mutex<T>` from `std/sync` protects one value behind exclusive synchronous
access:

```z
import { Mutex } from "std/sync";

struct RuntimeState {
  activeJobs: i32;
  completedJobs: i32;
}

function inspectRuntime(): i32 {
  const state = Mutex(RuntimeState({
    activeJobs: 0,
    completedJobs: 0,
  }));

  state.withLock((inout value): void => {
    value.activeJobs = value.activeJobs + 1;
  });

  return state.withLock(
    (in value): i32 => value.completedJobs
  );
}
```

`withLock` blocks the current OS thread until it acquires the mutex. It is not
an `await` point and does not yield the executor thread. The callback is
synchronous and non-escaping. `in` grants read access to the protected value;
`inout` grants read/write access. The lock is released when the callback
returns normally or throws. A typed throw does not poison the mutex; after the
error is handled, another `withLock` call may acquire it normally.
`Mutex<T>` is non-reentrant. A direct nested `withLock` on the same named
storage is a compile-time error because it would self-deadlock; reuse the
outer closure parameter or finish that critical section first.

The protected borrow cannot leave the callback. It cannot be returned as a
`view`, stored in another owner, or captured by an escaping closure. `await` is
not permitted while it is active. Returning a copyable value or an
independently owned result is valid:

```z
function snapshot(in state: Mutex<RuntimeState>): RuntimeState {
  return state.withLock(
    (in value): RuntimeState => copy value
  );
}
```

Owned results also work in the native compiler: for example,
`state.withLock((in value): String => copy value.title)` releases the lock
before handing the independent String to its caller. An `inout` callback may
similarly return ownership taken from protected storage using an operation
such as `remove` or `replace`; that is not a borrowed reference escaping.
Throwing callbacks preserve the error payload and unlock before `try` or
`attempt` handles it.

An inline `move` callback may transfer its owned captures into protected storage:

```z
const request = Request({ path: "/notes" });
inbox.withLock(move (inout state): void => {
  state.pending.push(move request);
});
```

This is safe because `withLock` invokes this synchronous, nonescaping callback
exactly once. The outer `move` transfers unique capture ownership into that call;
the inner `move request` transfers it onward. An early return or typed failure
destroys any captures not transferred. Shared identities retain their ordinary
sharing behavior. The callback environment is stack-local, with no additional
heap allocation. Ordinary reusable closures still cannot consume their owned
captures, and omitting the explicit `move` keeps the capture borrowed.

Declaring the local binding `const` fixes the mutex identity; it does not
freeze its payload. Mutation remains available only inside an `inout` callback.
`Mutex<T>` therefore provides controlled interior mutability without changing
the meaning of ordinary `const`.

When `T` is transferable and can be destroyed on any worker, a capturing
`thread.spawn(move () => ...)` closure receives an atomically retained handle
to the same mutex storage. The caller remains valid before and after joining
the worker. The `move` closure marker is still required because it makes the
native-thread capture boundary explicit. It does not promise that every source
binding is consumed: the captured type chooses copy, unique transfer, retained
sharing, or rejection. `Mutex<T>` chooses retained sharing, while `String` and
`Array<T>` choose unique transfer. Z does not duplicate the payload or native
mutex, and `copy state` remains invalid. Payloads containing main-isolated
identity, borrowed storage, or unknown destruction affinity are rejected when
the Mutex is captured.

A readonly ARC class whose reachable mutable state is entirely protected by a
shareable `Mutex<T>` may itself cross a native thread boundary. The mutex is
treated as synchronized retained identity rather than as an unknown mutable
field; its payload must still satisfy the transfer and destruction checks
above.

The scoped closure is Z's first-tier alternative to a user-visible lock guard.
It makes unlocking and the lifetime of the protected borrow structural, so
forgotten unlocks and escaped guards are not expressible. `RwLock<T>`, atomics,
condition variables, semaphores, asynchronous synchronization, timed
acquisition, public handle copying, and a public guard API remain separate
future layers.

### Typed channels

`std/channel` provides bounded multiple-producer, single-consumer channels with
split capabilities:

```z
import { Channel, ChannelClosed, Sender } from "std/channel";

struct Job {
  name: String;
}

async function publish(sender: Sender<Job>): void throws ChannelClosed<Job> {
  const job = Job({ name: "index" });
  try await sender.send(move job);
  sender.close();
}

async function main(): i32 throws ChannelClosed<Job> {
  const { sender, receiver } = Channel<Job>.bounded(8);
  const publishing = task publish(move sender);
  const next = await receiver.receive();
  try await publishing;
  return match (next) {
    some(job) => i32(job.name.byteLength) - 5;
    none => 1;
  };
}
```

`bounded(capacity)` requires a positive capacity. `Sender<T>` is a shareable
asynchronous sending endpoint; `Receiver<T>` is the unique asynchronous
receiving endpoint. An owned message requires `move`. A full bounded channel
suspends `send` without blocking its executor. An open empty channel suspends
`receive`. Closing wakes waiters, buffered messages remain receivable, and
`receive()` returns `Option.none` after the closed channel is drained.

Sending is fallible because closure may race the operation:

```z
const outcome = attempt await sender.send(move job);
match (outcome) {
  success => console.log("queued");
  failure(error) => recover(move error.value);
}
```

`ChannelClosed<T>` owns the unsent value. This preserves deterministic message
ownership rather than discarding it at the communication boundary.

Explicit endpoint conversion provides blocking OS-thread access:

```z
const syncSender = sender.sync();
const syncReceiver = receiver.sync();

try syncSender.send(move job);
const next = syncReceiver.receive();
```

`SyncSender<T>.send` blocks while full and `SyncReceiver<T>.receive` blocks
while empty and open. The receiver conversion consumes `Receiver<T>` so receive
authority stays unique. These operations do not suspend a task and should not
run on an executor thread that must remain responsive.

Only `Channel<T>.bounded(capacity)` is implemented. The explicit
`Channel<T>.unbounded()` spelling is reserved for a later storage tier; omitted
capacity will not mean unbounded. Zero-capacity rendezvous, channel selection,
timeouts, concurrent receive loans, and conversion back from synchronous
endpoints remain future work. The first tier requires direct
`await receiver.receive()` rather than creating a separate child task for a
unique receive operation.

`export c function` adds a stable C ABI entry point without removing the
ordinary Z export:

```z
export c function z_math_add(left: i32, right: i32): i32 {
  return left + right;
}
```

Z callers import and call `z_math_add` normally. Native consumers use the exact
source name from the generated header. `c struct` independently guarantees
target C field layout while retaining ordinary Z value semantics:

```z
c struct Point {
  x: f64;
  y: f64;
}
```

c enums add a mandatory scalar representation and retain exhaustive matching:

```z
c enum Status: i32 {
  ready,
  stopped,
}
```

The implemented ABI tier accepts synchronous, non-throwing, non-generic
signatures containing fixed-width scalars, owned `String` inputs, and checked
C-layout structs/enums. A `String` input appears as `const char *` in the
generated header; the wrapper validates UTF-8, makes one owned copy, and
transfers it to the ordinary Z implementation. `String` results remain
unsupported until the ABI can describe their allocator and release contract.
Library artifacts also generate target-scoped runtime initialize/shutdown
functions and bounded entry for host-created threads. A library manifest may
name one cleanup-bearing `target.runtime.initialize` result that the generated
runtime owns until shutdown; this is how an embedded library can retain a
`OnceLifetime<T>` or composed application root across C calls without adding
implicit module initialization. `RUNTIME_BUSY` leaves admission open because
teardown has not begun; `RUNTIME_DRAINING` closes admission while the host runs
a queued executor-bound root finalizer. See
[C exports](c-exports.md) for the exact mapping, lifecycle contract, and growth
path.

The filename contract is `.zs` for Z source and `.zd` for foreign declarations.
Z intentionally leaves `.z` to its established use as a compressed-archive
suffix on Unix systems.

## Tests

A test is a compiler-known top-level declaration:

```z
import { expect } from "std/test";

test "the answer is stable" {
  expect(42).toEqual(42);
}
```

Tests may appear among ordinary declarations in any `.zs` module. They are not
exported or callable as functions. An inline test shares its module's private
declaration scope; a dedicated `*.test.zs` module uses ordinary imports to test
public APIs. Test names must be nonempty and unique within their source module.

Expectation behavior is imported explicitly:

```z
import { expect, fail } from "std/test";

test "answer" {
  const answer = 42;
  expect(answer).toEqual(42);
}
```

`toEqual` follows Z's existing `==` semantics. Expectation operands use
statement-bounded immutable borrows, inferred by default or written explicitly
as `expect(in value)`. `fail(message)` and failed expectations run deterministic
cleanup and end only the current test; the runner continues with later tests.
Cleanup-bearing expression results must be bound before they are checked, and
tests do not gain an implicit source-level `throws` channel.

Ordinary builds exclude test declarations and their helper machinery
completely. `z test <file.zs>` discovers the tests in that module and its
project-owned import graph, emits a native runner, and executes it. The first
runner tier is synchronous, and expectation helpers currently appear directly
in test bodies. Assertions are standard-library behavior rather than
additional language syntax.

## Comments

Z supports TypeScript/C-style line and block comments:

```z
// Continues to the end of the line.
const answer = 42; /* May span
                      multiple lines. */
```

Block comments do not nest. An unclosed `/*` is a compile error reported at its
opening delimiter. Comments are trivia wherever source tokens are permitted,
including inside template interpolation expressions.

## Bindings and mutation

- `const` creates an immutable lexical binding.
- `let` creates a mutable lexical binding.
- Z has no `var` and no function-scoped declaration hoisting.
- Assignment is a statement, not an expression.
- A `const` value struct is deeply immutable through its fields.
- A `const` class binding fixes the reference, not the shared instance.

Local types are inferred from initializers when unambiguous. Public function
parameters and returns, fields, uninitialized storage, empty collections, and
foreign boundaries remain explicit contracts.

Value structs support object binding patterns with TypeScript-shaped aliases:

```z
const { path, revision } = record;
const { path: localPath } = record;
```

A cleanup-free struct may be destructured directly. Destructuring a named
cleanup-bearing struct requires `copy record` to preserve the source or
`move record` to consume it. Selected fields become independent bindings and
unselected owned fields are destroyed. Private fields are accessible only from
the declaring type. The current tier rejects classes, custom-`deinit` or foreign
RAII storage, and nested, object-rest, default, and parameter patterns.
The fixed-point native compiler implements the same rule for recursively
copyable Z-owned fields, including `String`, `Array<T>`, structs, and enums. It
evaluates the source once, clears every transferred slot, and destroys the
remaining temporary, so early returns cannot double-destroy or leak fields.

Stage 0 also executes value-struct patterns in async frames. The initializer is
evaluated once, including `try` and `await`; selected owned fields survive later
suspension and are cleaned on completion, error, or cancellation. As with other
owned async locals, cleanup-bearing patterns currently belong at the function
root or directly inside an explicit `async scope`. A scope inside a branch or
loop joins its children before destroying these fields. Borrowed-view and
positional array patterns in async frames remain deferred, and fixed-point
native execution of the combined destructuring/suspension shape is not yet
supported. These are lowering limits, not different destructuring semantics.

Fixed arrays, `Array<T>`, and `Slice<T>` support positional local patterns:

```z
const [first, _, third] = values;
const [head, ...remaining] = view values;
```

Plain bindings are checked reads and leave the collection available.
Cleanup-free elements load by value. `view` makes cleanup-bearing elements
owner-tied `view T` bindings and is required for rest; `remaining` is a
zero-allocation local `Slice<T>`. `_` is an explicit discard, rest must be last,
and dynamic sources trap safely when shorter than the requested positions.
Extra elements are ignored unless captured by rest. Assignment, parameter,
match, nested, default, and owned `copy`/`move` collection patterns remain later
tiers.

The fixed-point native compiler executes fixed arrays, including recursively
nested and cleanup-bearing shapes, plus `Array<T>` and existing `Slice<T>`
sources, including rest. It evaluates the collection once, performs one dynamic
length check where needed, then projects every requested position under that
proof. Fixed arrays use an inline value wrapper, so their length is compile-time
evidence and the wrapper itself never allocates. Functions may pass, move, and
return the whole owner across module boundaries. Explicit `copy` recursively
copies every element when the element graph is copyable; cleanup-bearing arrays
run element cleanup in reverse order. Literal lowering tracks each initialized
element, so a later failing `try` destroys the completed prefix before
propagating the error. Ordinary `for...of` borrows each element through the same
checked storage contract. Rest becomes a
two-word pointer/length descriptor and does not allocate or retain. A rest-only
pattern on an empty Array preserves a null data pointer without performing
pointer arithmetic. Cleanup-bearing elements require `view source` and remain
tied to the named collection owner, so a reallocating mutation is rejected until
every destructured element or Slice view's last use. Synchronous `Slice<T>`
parameters use the same descriptor, and passing a fixed array or Array to one
projects the whole backing range without copying. Individual cleanup-bearing
elements remain borrowed in this tier: moving one out would leave a partially
initialized owner, so ownership transfer happens at the whole-array boundary.

## Type vocabulary

Z uses lowercase names for primitive machine values and PascalCase names for
owned, nominal, or language/library abstractions. `cstring` is the deliberate
exception: it is a primitive borrowed foreign string view rather than a Z-owned
text value.

| Family | Z spelling | Meaning and current rule |
| --- | --- | --- |
| No value | `void` | Function produces no value; not ordinary storable data |
| Boolean | `boolean` | Exactly `true` or `false`; conditions do not use truthiness |
| Signed integers | `i8`, `i16`, `i32`, `i64` | Fixed-width two's-complement values; integer literals prefer `i32` |
| Unsigned integers | `u8`, `u16`, `u32`, `u64` | Fixed-width unsigned values; `u8` is the byte-oriented scalar |
| Pointer-sized integers | `isize`, `usize` | Signed/unsigned target pointer width; sizes and indexes normally use `usize` |
| Floating point | `f32`, `f64` | IEEE-width floating values; floating literals prefer `f64` |
| Owned text | `String` | Immutable owned UTF-8 bytes with explicit byte operations |
| Borrowed C text | `cstring` | Non-owning NUL-terminated native string view; not an owned `String` alias |
| Fixed collection | `T[N]` | Inline fixed-size owned array |
| Growable collection | `Array<T>` | Move-owned growable contiguous buffer |
| Associative collection | `Map<K, V>` | Move-owned key/value storage from `std/collections` |
| Unique collection | `Set<T>` | Move-owned unique-value storage from `std/collections` |
| Frozen owned collection | `readonly Array<T>`, `readonly Map<K, V>`, `readonly Set<T>` | Same owned storage after consuming zero-copy `freeze()`; read API only |
| Borrowed collection | `Slice<T>` | Non-escaping pointer/length view over contiguous storage |
| Optional value | `Option<T>` | Built-in `some`/`none` tagged value, niche-backed where representation permits |
| Typed outcome | `Result<T, E>` | Built-in `success`/`failure` tagged value produced by `attempt` |
| Async handle | `Task<T>` or `Task<T, E>` | Owned structured task handle; the second form carries a typed error channel |
| Weak identity | `Weak<T>` | Non-owning reference to an ARC-managed class, recovered through `upgrade()` |
| Text construction | `TextBuffer` | Move-only mutable UTF-8 builder imported from `std/text` |
| Region owner | `Arena` | Move-only region allocator imported from `std/memory` |
| Hash composition | `Hasher` | Compiler-supplied mutable state passed to `Hashable.hash`, imported from `std/hash` |
| Hash contract | `Hashable` | Nominal equality and hashing trait for readonly collection keys, imported from `std/hash` |
| Iteration contract | `Iterator<T>` | Nominal mutable-cursor trait imported from `std/iteration` |
| Generator sequence | `Generator<T>` | Cold move-only compiler frame imported from `std/iteration`; `.next()` returns `Option<T>` |
| Generator with completion | `Generator<Yield, Return>` | Cold frame whose `.next()` returns `GeneratorStep<Yield, Return>` with `yielded` or `complete` |
| Throwing generator handle | `Generator<Yield, Return, Error>` | Explicit storage spelling for a fallible generator; declarations normally use `Generator<...> throws Error` |
| Async generator | `AsyncGenerator<Yield, Return?, Error?>` | Cold move-only async frame imported from `std/iteration`; `.next()` returns an awaited `Task` |
| Function value | `(in value: T) => U throws E` | Closure/callback signature; parameter capabilities are part of the type |
| Read-only projection | `view T` | Inferred read-only borrow tied to owner storage, not a general reference type; fixed one-owner value composites may move only into their provenance Arena |
| Native types | Imported nominal names and `T | null` | ABI-exact C, Objective-C, C++, or Swift-generated types; nullability is limited to nullable native references/handles |
| User types | `struct`, `class`, `enum`, `trait` names | Nominal PascalCase declarations; structs/enums are values and classes have ARC identity |

There is currently no `char`, arbitrary-width integer, tuple, general structural
object type, `any`, or user-written nullable value union. Use `u8` for a byte,
`String` for owned UTF-8 text, `Option<T>` for optional Z values, and `T | null`
only where a native nullable representation enters the type system.

## Naming conventions

Z-authored APIs follow the familiar TypeScript convention:

| Subject | Convention | Example |
| --- | --- | --- |
| Types and traits | `PascalCase` | `Application`, `ServicesBuilder`, `Hashable` |
| Functions and methods | `camelCase` | `createServices`, `runApplication` |
| Fields, locals, and module exports | `camelCase` | `contentController`, `currentWindow` |
| True constant-style symbols | `SCREAMING_SNAKE_CASE` when useful | `DEFAULT_CAPACITY` |
| Source and declaration files | lowercase kebab-case | `desktop-core.zs`, `sqlite-contract.zd` |

Imported foreign names and explicit ABI exports preserve the spelling required
by that boundary. Therefore `sqlite3_open`, `zapp_desktop_run`, Objective-C
selectors, and C macro names remain native-shaped even when the surrounding Z
API is camel-cased. The distinction keeps ordinary Z code consistent without
obscuring or silently renaming the ABI being called.

Numeric construction performs an explicit value conversion:

```z
const widened = i32(byte);
const narrowed = u8(count); // traps if count is outside the u8 range
const nativeKind = u32(events.SDL_EVENT_QUIT);
const nativeWidth = f64(width);
```

Conversions whose complete source range and precision fit the destination lower
to a direct cast. Other conversions perform a runtime representability check.
A float-to-integer constructor accepts only finite, integral, in-range values;
an integer-to-float constructor traps rather than silently round. Round first
when changing the value is intentional:

```zs
import math from "std/math";

const pixels = u32(math.trunc(measuredWidth));
```

A nominal imported
C enum may convert outward through its ABI integer representation; ordinary
assignment remains nominal, and an arbitrary integer cannot be constructed
back into the enum.

## Structs, classes, and traits

`struct` declares a value type. It may contain fields, instance methods, static
methods, and `deinit`. Construction uses the type as a function over an object
value:

```z
const point = Point({ x: 20, y: 22 });
```

Value-struct fields may declare defaults. Omitted fields evaluate their defaults
independently for every construction; an explicit field suppresses its default:

```zs
struct RequestOptions {
  retries: i32 = 3;
  timeoutMilliseconds: i32 = 1000;
  headers: Array<String> = Array<String>();
}

const defaults = RequestOptions();
const equivalent = RequestOptions({});
const patient = RequestOptions({ timeoutMilliseconds: 5000 });
```

`Type()` is zero-argument value construction, not punctuation sugar for an
object literal. It is valid only when every field has a default. `Type({})`
spells the same all-default construction explicitly, while partial object
initializers override selected defaults. Owned defaults such as `Array<T>` are
fresh values owned and destroyed by each resulting struct. Defaults cannot
refer to `this` or sibling fields in the first tier. Class-field defaults remain
deferred; class constructors establish their fields explicitly.

One leading spread can derive a value from another value of the same nominal
struct type:

```zs
const resized = WindowOptions({
  ...defaults,
  width: 1200,
});

const copied = WindowOptions({
  copy ...saved,
  title: "Copy",
});

const installed = WindowOptions({
  move ...pending,
  title: "Installed",
});
```

The source must be a named local with the exact constructed type, including
generic arguments. Arbitrary spread expressions are not accepted in the first
tier. The spread is evaluated once, appears before every explicit field, and
supplies all fields not explicitly overridden. Explicit fields are evaluated
afterward in source order and win over their spread counterpart. Because the
source is a complete value, defaults do not run during spread construction.

| Form | Retained fields | Source afterward |
| --- | --- | --- |
| `...source` | ordinary cleanup-free copies and shared identities | available |
| `copy ...source` | explicit Z copies; every retained field must support `copy` | available |
| `move ...source` | ownership transfers; the struct must carry unique ownership | entirely unavailable |

Capability checks apply only to retained fields. Overriding a move-only field
therefore does not prevent `copy ...source`, because that source field is never
copied. Explicit copy follows Z's ordinary copy semantics, so a shared class
identity is not silently deep-cloned: a retained class field rejects
`copy ...source` unless that field is explicitly overridden. A move spread is
intentionally whole-source consumption rather than a partial move: retained
fields transfer, while overridden cleanup-bearing source fields are destroyed
exactly once. Cleanup also remains correct if evaluating a later override exits
before construction completes.

A `move this` value-struct method may also transfer its sole
ownership-bearing field:

```zs
struct Registry {
  handlers: Map<String, Handler>;

  function finish(move this): readonly Map<String, Handler> {
    return this.handlers.freeze();
  }
}
```

The field transfer consumes the whole receiver and disables its cleanup guard;
the returned value now owns that storage. The first tier rejects this extraction
when the struct defines custom `deinit` or another field also needs cleanup.
Those shapes require a future general partial-move model; Z never leaves an
aggregate responsible for emptied owned storage.

Nested Z-owned resources are supported, including `String`, collections,
options, enums, classes, and Z structs that define `deinit`. The first tier
rejects spreading an outer struct that defines its own custom `deinit`, because
field-wise reconstruction could violate its aggregate invariant. It also
temporarily rejects nested native C++/Swift/foreign value storage until native
relocation and destruction participate in this lowering.

Multiple construction spreads are deferred until Z defines per-spread
capability and left-to-right conflict rules. Object-rest destructuring is a
separate future design: `const { foo, ...rest } = value` needs either a named
nominal remainder type or an intentionally designed anonymous remainder record.
No syntax or type model for either extension is locked by this tier.

An optional struct field uses `?` after its name. It describes optional
presence, not a nullable Z value:

```zs
struct WindowOptions {
  url: String;
  title: String = "Z App";
  icon?: Image;
  parent: Option<WindowHandle>;
}
```

The declaration `icon?: Image` stores `Option<Image>` and behaves as though it
had an implicit `Option.none` default. Omitting `icon` therefore constructs
`none`. Supplying a direct `Image` contextually constructs `some(image)`, with
the same ownership transfer that an explicit `Option.some(image)` would
perform. Supplying an already constructed `Option<Image>` is also valid.

```zs
const withoutIcon = WindowOptions({
  url: "https://example.com",
  parent: Option.none,
});

const withIcon = WindowOptions({
  url: "https://example.com",
  icon: move loadedIcon,
  parent: Option.none,
});
```

The field shapes are deliberately distinct:

| Declaration | May be omitted | Stored type |
| --- | --- | --- |
| `url: String` | No | `String` |
| `title: String = "Z App"` | Yes; evaluates the default | `String` |
| `icon?: Image` | Yes; becomes `none` | `Option<Image>` |
| `parent: Option<WindowHandle>` | No; the caller supplies `some` or `none` | `Option<WindowHandle>` |

`field?: T` cannot also declare an explicit default because optional presence
already supplies the `none` default. Native Z values remain non-null:
`Option<T>` is Z optionality, while `T | null` primarily represents honest
nullable foreign values.

Optional chaining conditionally reads an immutable member or calls an immutable
method. Its receiver may be an `Option<T>` or a nullable foreign reference:

```zs
const userId = dashboard.activeSession?.userId;          // Option<i32>
const selection = dashboard.activeSession?.selection();  // Option<i32>, flattened
dashboard.activeSession?.report();                       // void; absent is a no-op
```

An ordinary result is lifted to `Option<U>`. If the member or method already
produces `Option<U>`, the result stays flat rather than becoming
`Option<Option<U>>`. Chaining composes through that rule:

```zs
const scale = dashboard.activeSession?.display()?.scale;
```

Stored cleanup-bearing values are not implicitly copied. Reading a stored
`String`, move-only struct, or other cleanup-bearing field through `?.` produces
`Option<view U>` tied to the named receiver owner. A method that constructs and
returns a fresh owned `U` instead produces `Option<U>`:

```zs
const title = dashboard.activeSession?.displayName;  // Option<view String>
const label = dashboard.activeSession?.summary();    // Option<String>
```

A method declared to return `view U` likewise produces `Option<view U>`, but
the optional receiver must have a stable named owner. The view's provenance is
tied to that binding:

```zs
const shelf = makeShelf();
const current = shelf?.current();  // Option<view Book>, tied to shelf

const invalid = makeShelf()?.current(); // rejected: temporary owner
```

Optional chains are value-producing conditional access, never lvalues.
`value?.child = replacement` and nested targets such as
`value?.child.name = "updated"` are rejected. Use an explicit `match` to unwrap
the receiver before mutation.

Throwing behavior is preserved rather than swallowed. For a method returning
`U throws E`, absence is a successful `none`, while a call on a present receiver
may still fail with `E`:

```zs
const loaded = try dashboard.activeSession?.loadSummary();       // Option<String>
const observed = attempt dashboard.activeSession?.loadSummary(); // Result<Option<String>, E>
```

The first tier is an immutable conditional borrow. Calling an `inout this` or
`move this` method through `?.` is rejected; use an explicit `match` when
mutation or ownership transfer must be visible. The receiver is evaluated once.
Nullable native receivers keep their native null representation, and ordinary
`Option<T>` uses its existing niche or tag-plus-payload representation.
This first executable tier is synchronous. Async source is parsed and checked,
but optional-chain execution inside Phase-1 async frames remains deferred.

`class` declares an ARC-managed reference type with identity. Construction uses
`new`; copying a class reference shares the instance:

```z
const session = new Session({ id: 42 });
const same = session;
```

Field visibility is separate from storage and ownership: struct and class fields
are public unless marked `internal` or `private`. `internal` grants the owning
manifest-defined package access; `private` grants only the declaring aggregate.
Explicit struct field initialization follows that visibility too: a private
field may be supplied by a static factory on the struct, not by an outside
caller. Outside callers may still omit a private field with a declared default.
A user class constructor may establish invariants and may throw. Constructors
use the same visibility words:

```zs
export class Session {
  private readonly id: u64;

  internal constructor(id: u64) {
    this.id = id;
  }

  static function createForTests(id: u64): Session {
    return new Session(id);
  }
}
```

An omitted or `public constructor` is callable wherever the class is visible.
An `internal constructor` is callable only from the exact manifest-defined
package. A `private constructor` is callable only inside its declaring class,
including a static factory. The class can still cross a public API as a named
type; public metadata and external editor call surfaces omit an inaccessible
constructor signature. Constructors remain class-only; value structs continue
to use `Type(...)` construction.

`trait` is a nominal behavior contract; a struct or
class opts in with `implements`. Traits do not imply inheritance or storage.

Imported Objective-C protocols use the same nominal `implements` list. A
protocol method keeps an ordinary Z-local name and attaches its native selector
after the result:

```zs
class TableController implements AppKit.NSTableViewDataSource {
  function rowCount(
    in tableView: AppKit.NSTableView
  ): isize as "numberOfRowsInTableView:" {
    return 0;
  }
}
```

The selector is declaration evidence, not a stringly typed runtime lookup. The
compiler verifies that it belongs to an implemented protocol and checks its
parameters and result against Clang's SDK declaration. Protocol callbacks are
synchronous and non-throwing in the first tier. The editor offers
unimplemented selectors as complete method scaffolds and identifies required
versus optional requirements.

An Objective-C protocol-qualified callback parameter uses the imported
protocol as its Z type:

```zs
function start(
  in webView: WebKit.WKWebView,
  in task: WebKit.WKURLSchemeTask
): void as "webView:startURLSchemeTask:" {
  task.didFinish();
}
```

It is a borrowed synchronous capability in the current tier. It must use `in`
and cannot be stored, returned, or carried across `await`.

A field marked `readonly` is initialized during construction and cannot be
assigned or mutated afterward:

```z
class Configuration {
  readonly name: String;
  readonly retries: i32;
}
```

Prefixing an aggregate applies the same rule to all of its stored fields:

```z
readonly struct Coordinate {
  x: i32;
  y: i32;
}

readonly class Configuration {
  name: String;
  retries: i32;
}
```

This is shallow binding immutability. A field cannot be reassigned through the
aggregate, but a referenced value is not recursively frozen merely because its
field is readonly. In particular, an ARC class stored in a readonly field may
still expose mutable methods; the field keeps the class identity stable while
the class owns its internal state. Value structs and owning collections stored
directly in readonly fields remain immutable through that path. Executor and
exclusivity rules still apply to every class method call. Deep cross-thread
shareability is a separate recursive compiler proof. Constructors may initialize
readonly fields while establishing the value's initial state.

Collections can also carry `readonly` in the type position. The two positions
express different contracts:

```z
class Router {
  readonly handlers: readonly Map<String, Handler>;
}
```

The first `readonly` prevents replacing `handlers`; the second removes the
Map's structural mutation surface. `readonly Array<T>`, `readonly Map<K, V>`,
and `readonly Set<T>` remain owning values with deterministic cleanup. They are
not views and do not add reference counting. A deeply readonly class may share
such storage across threads when every reachable element is also shareable.

When every reachable field is similarly immutable and safe to destroy on any
thread, Z infers the class as shareable and uses atomic ARC for its references.
Mutable collections, mutable receiver methods, custom `deinit`, and native
identity without a threading contract prevent that inference.

## Ownership capabilities

Capabilities are written before the binding because they describe how the
callee may use the argument:

| Capability | Callee contract | Caller spelling | Typical use |
| --- | --- | --- | --- |
| value/default | receives ownership or an ordinary copy/share according to the type | `use(value)` | transfer a unique value; share a class |
| `in` | read-only, non-escaping borrow | `inspect(value)` or `inspect(in value)` | inspect without transfer |
| `inout` | exclusive, initialized mutable borrow | `mutate(inout value)` | mutate caller-owned storage |
| `out` | exclusive write into possibly uninitialized storage | `fill(out value)` | initialize caller storage |
| `move` | declaration or closure explicitly consumes captured/receiver ownership | `consume(value)`; `move () => ...` for a closure | consuming captures and receivers |

Function declarations and function types include the same capabilities. This
keeps callbacks and ordinary functions substitutable.

An inline dynamic Array may be borrowed by a synchronous call without a
user-authored local:

```z
function sum(in values: Array<i32>): i32 {
  return values[0] + values[1];
}

const answer = sum(Array<i32>(20, 22));
```

Z materializes one hidden owned Array, passes a read-only pointer for the call,
and destroys that Array immediately after the result is secured. This is a
call-scoped convenience, not an escaping borrow or ARC allocation. Async
borrows still require named, address-stable storage, and `inout`/`out` still
require explicit mutable caller storage. Other cleanup-bearing temporary shapes
must currently be bound before borrowing.

For ARC classes, `inout` applies to the shared object identity rather than only
to one variable spelling. Direct aliases are tracked without a runtime check:

```z
let document = new Document({ title: "Draft" });
const inspector = document;

publish(inout document);       // bounded exclusive operation
console.log(inspector.title);  // the alias is available again afterward
```

Passing `inspector` into that same call as another `in`, `inout`, value, or
`move` use is rejected because both bindings name one ARC object. This first
local-uniqueness tier follows direct local copies and assignments. It also
follows an explicitly initialized direct class field of a local value struct:

```z
const context = Context({ application: document });
publishAndInspect(inout document, context.application); // rejected
```

Projecting that field into another local preserves the same identity, and
replacing a mutable direct field updates the evidence. A context holding a
different class instance remains valid. This is compile-time call-exclusivity
evidence only: it adds no runtime metadata and does not make the stored class
locally contained for class-field `view` projection. Spread, nested aggregate
paths, collections, general returned aggregates, and suspension remain
conservative boundaries except for one audited direct-return shape. A
synchronous, nonthrowing, nongeneric free function whose body contains only
blocks, `if` branches, exhaustive statement-form `match`, and direct
value-struct returns preserves class
parameters placed into direct class fields when every reachable return agrees:

```z
function contextFor(in application: Application): Context {
  return Context({ application });
}

let application = new Application({ name: "Primary" });
const preview = new Application({ name: "Preview" });
const context = contextFor(preview);
publishAndInspect(inout application, context.application); // distinct: accepted
```

Calling `contextFor(application)` instead preserves the shared identity and the
same exclusive call is rejected. An early `if` return followed by a final
return, or an exhaustive `if`/`else if`/`else`, receives the same summary when
all returns map each field to the same parameter. Exhaustive statement matches
follow the same rule, including arms with non-shadowing payload bindings. A
payload binding that shadows a function parameter with the same spelling
withholds the summary rather than confusing the two identities. The summary crosses
source-module boundaries and adds no source syntax or runtime provenance. A
local statement, disagreeing branch, spread, throw, async effect, generic
parameter, different return source, or indirect initializer makes the result
opaque again. An opaque direct class
field is treated as potentially aliasing any other class identity in the same
exclusive call; only precise construction evidence restores independence. A
direct inline closure passed to the call also contributes its captured ARC identities:
capturing `inspector` in a callback beside `inout document` is rejected because
the callback may run before the synchronous call returns. Provenance through
arbitrary function results, previously stored callable environments, and
broader aggregate shapes remains conservative work; cross-thread mutation
continues to require `Mutex<T>` or executor isolation.

This tier does not yet analyze a value-producing `return match (...) { ... }`;
that shape composes return-expression provenance rather than statement control
flow and remains opaque.

Closure capture preserves the distinction between a class binding and its
instance. An owned `const` class reference may still invoke an `inout this`
method from a synchronous closure because the reference itself is not replaced.
An immutable `in` borrow may not gain mutable instance access by being captured,
and assigning a new reference to a captured binding still requires `let`.

Fixed-layout value structs also permit capabilities to project through direct
field paths:

```z
struct Point {
  x: i32;
  y: i32;
}

function adjust(inout x: i32, inout y: i32): void {
  x = x + 1;
  y = y - 1;
}

let point = Point({ x: 20, y: 22 });
adjust(inout point.x, inout point.y);
```

The two writable loans are accepted because `x` and `y` are disjoint stored
fields. Repeating `point.x`, or combining `inout point` with
`inout point.x`, is rejected. The same projection is available to explicit
`in` calls. It does not allocate, construct a reference object, or insert a
runtime alias check; C lowering passes the two field addresses directly.

This first projection tier is synchronous and follows named fields through
value structs only. `out` still initializes a complete binding. ARC class
fields and mutable method receivers, dynamic indexes, array-to-Slice projection,
and any borrow that crosses async suspension remain conservative because their
address or alias stability needs stronger proof.

### Callable thread contracts

An ordinary function value is executor-local. When a callable may be stored in
a shared graph and invoked concurrently from arbitrary registered threads, its
type states the stronger contract explicitly:

```z
import { thread } from "std/thread";

type Handler =
  (in message: Message) => i32 throws RouteError on thread.any;

function route(in message: Message): i32 throws RouteError on thread.any {
  return message.value;
}

const offset = new Offset({ value: 20 });
const handler: Handler = move (in message) => message.value + offset.value;
```

`on thread.any` does not create a thread, schedule work, or hop executors. It
is a semantic promise that the callable may be invoked concurrently wherever
its owner is valid. Z therefore uses atomic ownership for a capturing closure's
environment and recursively checks every capture. The first tier accepts
primitives, immutable owned snapshots, frozen collections, deeply readonly ARC
classes, `Mutex<T>`, and other values already proven shareable. Mutable,
borrowed, view, weak, native-without-contract, and `thread.main`-bound captures
are rejected.

A thread-any callable may be passed to an ordinary executor-local function
type; the reverse is rejected because it would erase the stronger capture and
ownership proof.

A stored callable may instead preserve main-executor isolation:

```z
type LifecycleOperation = () => i32 on thread.main;

function prepareWindow(): i32 on thread.main {
  return 42;
}

struct LifecycleEntry {
  start: LifecycleOperation;
}

function main(): i32 on thread.main {
  const operation: LifecycleOperation = prepareWindow;
  const entry = LifecycleEntry({ start: operation });
  return entry.start() - 42;
}
```

`on thread.main` also does not schedule or hop. It preserves the proof required
to construct, invoke, store, and destroy the callable environment. Aggregates
containing such a callable inherit main lifecycle affinity. A `thread.any`
callable may satisfy a `thread.main` destination, but a main-only callable
cannot be weakened to an ordinary executor-local type or transferred to a
worker. Contextually typed `move` closures receive main proof in their bodies,
so they may safely capture and use main-isolated state.

Stored async operations use the same function-type shape with an explicit
`async` prefix:

```z
type AsyncHandler =
  async (in invocation: ServiceInvocation) => ServiceOutcome
  throws ServiceError
  on thread.any;

const handler: AsyncHandler = async move (in invocation) => {
  return try await dispatch(in invocation);
};
```

Constructing or storing `handler` does not start work. Calling it beneath
`await` starts one child task on the current executor and joins that child at
the await point:

```z
const outcome = try await handler(in invocation);
```

A bare call is rejected because it would neither acknowledge nor own the async
work. `async`, parameter capabilities, `throws`, and the executor contract are
all part of the callable type; a synchronous closure cannot silently satisfy an
async destination. Capturing async closures own their environment through ARC,
and `on thread.any` applies the same recursive shareability proof used by
synchronous callables.

The executable Stage 0 stored-async tier accepts contextually typed async
closures through direct `await` invocation or a hot structured task:

```z
async scope {
  const pending = task handler(in invocation);
  doOtherWork();
  const outcome = try await pending;
}
```

The task has the callable's exact `Task<T, E>` contract. Await transfers its
result or typed error, `await pending.cancel()` consumes the handle after child
cleanup, and scope exit joins an unobserved child. An `in` argument captured by
a hot child task must currently come from named storage inside an explicit
`async scope`, keeping its address stable and its owner live through every exit.
For a sequential direct await, a fresh aggregate constructor may be passed
directly: Z materializes an address-stable owner in the parent task frame and
cleans it after child teardown. Named async-function conversion remains staged.

The fixed-point native compiler executes completed expression closures and the
first honest suspension shape: a void closure consisting of one direct
`await scheduler.yield()`. That closure owns a heap frame, yields to a local
FIFO executor on its first poll, resumes on its second poll, and then completes.
For the first bounded linear `async main` shape, the enclosing Z function now
also owns a heap frame. Its callable local remains live in that frame while the
dynamic child is suspended; completing the child requeues the parent task, and
the resumed parent transfers the child result, destroys the invocation, and
then cleans its local. One ordinary local may also live in that parent frame,
cross into the stored callable as its single argument, and be used again after
the parent resumes. Cleanup-free values cross by value. An ownership-bearing
value crosses as `in`, so the frame remains its sole owner while the child sees
an address-stable borrow. Such storage carries a live bit: normal completion
destroys it once after the return expression, while destruction of an
unfinished frame also cleans it. The generated poll function exposes the local
only during each active poll; its storage remains in the heap frame while the
child owns the executor turn. The frame ABI also propagates cancellation: a
parent request marks its suspended child, the child reaches a cancelled terminal
state at its next poll, and its waiter wake-up lets the parent destroy the
invocation and live owners. Destroying unfinished work first unlinks its frames
from the executor queue.

The next fixed-point tier generalizes that mechanism to a direct async adapter:

```z
async function relay(
  operation: Operation,
  in request: Request
): Response {
  return await operation(in request);
}
```

The adapter's heap frame owns `operation`, keeps `request` as an address-stable
borrow, starts the dynamic child on the current executor, and becomes its
waiter. Child completion requeues the adapter; cancellation is forwarded to the
child; and cleanup transfers or destroys each owned argument and result exactly
once. Locals, loops, and matches surrounding that await remain a later native
frame-planning tier rather than falling back to a nested blocking executor.
The same body may be a non-consuming ARC class method. In that form the parent
frame also retains the receiver until the child has completed or cancellation
cleanup has finished.
Straight-line local declarations before the tail await are also preserved in
that method frame. This permits an owned request or adapter value to be built
locally and lent to the child without exposing a lifetime annotation in Z.
Non-suspending loops and branches may precede the tail await. An early branch
can complete the parent with an immediate result while the other path proceeds
to the child suspension. The method may also end in a consuming enum match that
extracts one owned async callable. The selected payload moves into guarded frame
storage before the child starts; non-selected arms may return immediately. This
is the executable fixed-point shape used by a frozen service registry's
`Option<AsyncServiceHandler>` lookup.
The same bounded shape is available to an async free function, including
cleanup-bearing prefix locals retained until the selected child finishes.
One awaited non-consuming ARC method result may also initialize a local in a
direct async free function. The local and method receiver live in the heap frame
while the child is pending; after completion, ordinary synchronous control flow
may inspect, transform, return, or move the local without another source-level
lifetime marker.
An expression-bodied captured async closure may directly await a non-consuming
ARC method as well:

```z
function handler<T: Service>(service: T): Handler {
  return async move (in request: Request): Response =>
    await service.invoke(in request);
}
```

The closure remains cold. Calling it starts a child frame on the caller's
executor; its captured environment and borrowed arguments remain alive until
the method completes or cancellation finishes unwinding the child.

The expression body may retain a fallible child as an ordinary result:

```z
type Operation = async () => Result<Value, OperationError> on thread.main;

const operation: Operation = async () =>
  attempt await loadValue();
```

The stored callable is infallible at its outer boundary: invoking it produces
one `Result<Value, OperationError>`. Its child task's existing result storage is
transferred into the callable frame without an additional allocation or nested
result. Suspended `try await` propagation from a stored closure remains a later
native lowering tier.

The fixed-point emitter now reuses that same frame for the first public
callable-backed task shape inside an unnamed `async scope`. A stored
nonthrowing void callable may start one hot `Task<void>`, borrow one named owner,
and then be consumed through either `await pending` or
`await pending.cancel()`. Ordinary await treats child cancellation as structural
parent cancellation. Explicit `cancel()` requests child cancellation and joins
it, then resumes the parent normally so it may reuse the borrowed owner before
exactly-once cleanup. This is a real stackless executor path, not a blocking
imitation. Typed task results/errors, implicit scope-exit join, multiple
children, named scopes, multiple locals/arguments, and broader enclosing control
flow remain Stage-0-only or staged in the fixed-point emitter.

An untyped uninitialized binding is accepted only when its first initializing
use is a typed native `out` call:

```z
let database;
try sqlite.sqlite3_open(":memory:", out database);
```

The imported `T **` contract determines the binding's `T *` type. If no such
call initializes the binding, Z asks for an explicit type annotation instead of
leaving an implicit undefined value.

Borrow lifetimes are inferred and lexical. Safe code does not expose general
lifetime parameters. Ordinary borrows cannot be retained or stored. A local
projection uses the same readable ownership vocabulary as `copy` and `move`:

```z
const node = view tree.nodes[index];
inspect(node);
tree.append(next); // valid after node's last use
```

For a direct fixed-layout field, both semantic frontends record the selected
field path. The owner may be a value struct or a locally contained named Z
class reference. A synthesized `new Class({ ... })` identity and its direct
named aliases qualify. Arbitrary function results and classes created by a
user-defined constructor do not, because aliases may have been published
outside the lexical proof. Passing the class as an owned value, storing it, or
move-capturing it invalidates containment for every known alias.
A direct readonly class field is the safe exception. Any retained alias may
borrow or view that field because no alias can replace its storage; the named
class binding keeps the owner alive for the lexical loan. This permits shared
application-style roots to expose stable owned value snapshots without copying:

```z
readonly class Application { menu: Menu; }

const application = Application.current();
inspect(in application.menu);
```

The exception is immutable and synchronous. `inout`, a mutable direct field,
nested ARC-class projection, and suspension retain the conservative rules.
A live `view document.title` blocks replacement of `title` or mutation of the
whole `document`, while mutation of the disjoint `document.revision` field is
safe. Known local aliases of a class share the same proof: an alias cannot
replace the viewed field or call an `inout this` method while the view is live,
but it may mutate a disjoint direct field. A `const` class binding fixes the
reference rather than freezing the instance, so it may pass a mutable direct
field as `inout` unless the class itself was received through an immutable `in`
borrow.

Direct class identity stored in a local value-struct field participates in
bounded call exclusivity, but it does not qualify as locally contained identity
for a class-field `view`. Nested aggregate traversal, foreign reference
identity, dynamic indexing, escape, and suspension remain conservative
boundaries. Attempting to escape a contained
identity while one of its field views is live is rejected before the alias can
be hidden. A view remains a usable borrowed value after control-flow joins; its
owner loan ends independently at the view's proven last use.

`view expression` must directly initialize an inferred `const` local or a
direct retained-result field, and must project a field or indexed element from
named value storage or a direct field from a named Z ARC owner. Hover reports both
the projected `view T` and its owner. It creates a `const T *` in generated C;
there is no value copy, allocation, retain, or cleanup.

Read-only operations preserve that representation for intrinsic containers.
A local `view Array<T>` supports checked indexing, `length`, and `for...of`
iteration without copying the growable buffer. A `view String` supports
comparison, interpolation and typed console formatting, `byteLength`,
`isEmpty`, `byteAt`, and the explicit owned `copyBytes` operation. These
operations do not create a second lifetime:
the container or string view remains tied to the original named owner until its
last use, and mutation through the view remains invalid.

A narrow `view T` method result may provide the same read-only projection
through owner behavior:

```z
struct DocumentStore {
  documents: Array<Document>;

  function documentAt(index: usize): view Document {
    return this.documents[index];
  }
}

const document = store.documentAt(0);
console.log(document.title);
store.open(next); // valid after document's last use
```

Module functions can express the same relationship through immutable inputs:

```z
function choose(
  preferDraft: boolean,
  in drafts: DocumentStore,
  in published: DocumentStore
): view Document {
  if (preferDraft) return drafts.documents[0];
  return published.documents[0];
}

const selected = choose(true, in drafts, in published);
console.log(selected.title);
```

The runtime result is still one `const Document *`. Because either input may
own that pointer, the compiler conservatively keeps both stores under immutable
loans until `selected` is last used. Hover reports both possible owners.

The first tier is deliberately owner-tied and zero-overhead. A method producer
must be synchronous and non-throwing, borrow a value-struct receiver, and return
a direct field or indexed projection. A module producer must likewise be
synchronous and non-throwing and return an immutable `in` parameter, its field,
or an indexed element. Local producers have the same value-storage and
direct-projection restrictions. Outside the retained aggregate tier below, the
view itself cannot be annotated as storage, duplicated, stored, returned again,
or held across `await`. A module
function may also return `Option<view T>` by constructing `some` directly from
one or more immutable input projections, or by forwarding an owner-tied method
result. `none` carries no live borrow. At the call site, every possible input
owner remains immutable until the optional binding or matched payload is last
used; the runtime representation is still one nullable pointer. The view may be
forwarded to a synchronous `in T` parameter or read through an inline closure
passed to a synchronous `in` function parameter. The latter closure is
compiler-proven nonescaping and copies only the view pointer into its stack
environment; owned, stored, mutable, escaping, and async forwarding remain
rejected. Its owner cannot mutate or move before the view's last use. ARC class
owners are excluded because another alias could invalidate growable projected
storage. Parameter provenance remains direct and synchronous.

A synchronous non-throwing borrowed value-struct method or module function may
retain several projections from one immutable owner in a named value struct:

```z
struct DocumentSpan {
  first: view Document;
  last: view Document;
}

struct DocumentStore {
  documents: Array<Document>;

  function endpoints(): DocumentSpan {
    return DocumentSpan({
      first: view this.documents[0],
      last: view this.documents[this.documents.length - 1],
    });
  }
}

function endpoints(in workspace: DocumentStore): DocumentSpan {
  return workspace.endpoints(); // provenance-preserving forwarding
}

const { first, last } = endpoints(in workspace);
console.log(first.title, last.title);
workspace.open(next); // valid after both destructured views' last reads
```

The returned struct is a stack value containing `const T *` fields. It adds no
allocation, retain, provenance tag, or cleanup. Every view field in one returned
instance must be written with explicit `view` and derive from the same immutable
`this` receiver or `in` parameter; different return paths may choose different
parameters, so the caller conservatively loans every possible source. The
ultimate producer constructs the value directly at `return`. A synchronous
wrapper may then return that method/function result or forward an immutable
`in` aggregate while preserving the source parameter in its callable contract.

The caller may retain the aggregate in `const`, pass it to a synchronous `in`
parameter, or object-destructure it. Each destructured view carries the same
owner provenance, so mutation becomes legal only after every resulting binding
has reached its final use. Mutable destructuring remains invalid. Returning
local storage, struct spread at the producer boundary, ARC-class methods,
`inout`/`move this`, `throws`, async suspension, nested view-bearing fields, and
storage in classes, enums, or collections remain outside this tier. The owner
cannot mutate, move, or deinitialize while any aggregate or destructured view is
still live.

When `T` already has ordinary cleanup-free copy semantics, a value context may
load an independent `T` from `view T` implicitly. This is an ordinary by-value
load from the referenced storage—not a heap allocation, retain, or clone. A
scalar is one load; a cleanup-free aggregate has its normal value-copy cost. The
result may outlive the view. Cleanup-bearing and move-only targets remain views;
obtaining an owned copy of those values requires a type-specific operation.
Binding a receiver projection without an owned type annotation still infers
`view T`, so the borrow is not silently erased.

Value-producing `match` and `if` arms are value contexts. A concise arm provides
its expression directly; a block arm uses `select`, while `return` always exits
the enclosing function:

```z
return match (in found) {
  some(count) => count;
  none => 0;
};

const adjusted = match (in found) {
  some(count) => {
    if (count < 0) return -1;
    select count + 1;
  }
  none => 0;
};
```

A cleanup-free view selected by either shape materializes as the arm's owned
value. This contextualization happens before branch types are unified, so a
`view i32` arm and an `i32` arm agree on `i32`.

A lookup that may not find a value returns `Option<view T>` without copying the
payload:

```z
function find(id: i32): Option<view Document> {
  let index: usize = 0;
  while (index < this.documents.length) {
    if (this.documents[index].id == id) {
      return Option.some(this.documents[index]);
    }
    index = index + 1;
  }
  return Option.none;
}

const found = store.find(42);
match (in found) {
  some(document) => console.log(document.title);
  none => console.log("not found");
}
```

The initial optional tier requires a direct `const` binding and
`match (in binding)`. The `some` binding inherits the receiver provenance and
is read-only; the `none` arm carries no borrow. Native lowering uses a single
`const T*`: a projected address for `some` and `NULL` for `none`. The owner may
mutate again after the optional view's last use.

A borrowed callback can expose a scoped view without returning it:

```z
function each(in visit: (in item: Item) => void): void {
  for (const item of this.items) {
    visit(item);
  }
}
```

The immutable `in` capability appears in the function type. Its call site
normally infers the borrow, while an explicit matching `in` may be written when
that makes ownership intent clearer. Mutable `inout` and initializing `out`
remain explicit at both declaration and call sites.

## Cleanup and weak references

`deinit` is deterministic, synchronous, infallible, and runs exactly once for
owned value storage or when the final strong class reference ends. Fallible
resource shutdown belongs in an explicit operation such as `close()`.

`weak value` creates a non-owning `Weak<T>` for a class. `upgrade()` either
returns a strong reference or throws `WeakExpired`. Weak references are the
cycle-breaking tool; cycle collection remains a separate runtime concern.
The fixed-point runtime uses a zeroing control shared by copied `Weak<T>`
handles: final strong release clears the control before `deinit`, while a
successful upgrade creates a new strong owner. Ordinary and concrete generic
class identities use the same mechanism.

## Functions, errors, and results

A throwing signature names its error domain:

```z
function load(id: i32): User throws UserError { ... }
```

- `return value` completes successfully.
- `throw error` completes with the declared error.
- `try operation()` propagates failure and produces the success value.
- `attempt operation()` materializes `Result<T, E>` for local inspection.

Propagation is an expression and can compose where its success value is
needed. In async code, suspension and propagation remain explicit together:

```z
const total = combine(
  try await firstTask,
  try await secondTask
);
const length = measure(try await textTask);
```

Each operation is awaited in source order. A failure skips the enclosing value
expression, destroys already-produced hidden values plus ordinary live owners,
and returns the compatible error from the enclosing function. A successful
cleanup-bearing value is borrowed or transferred according to the receiving
parameter capability exactly as though it had first been given a local name.

Synchronous and async error values may contain cleanup-bearing fields such as
`String`, ARC identity, or move-only native owners nested in a Z value.
`throw` transfers the error into failure storage; `try` transfers it onward;
and `attempt` materializes a live-state-aware `Result<T, E>`. Consuming or
borrowed `match` follows the same payload rules as other enums. Native-bearing
failure storage uses placement construction, typed moves, and deterministic
destruction rather than plain aggregate assignment.

`Result<T, E>` is a built-in tagged union with `success` and `failure` variants;
those names are variants, not global functions or reserved keywords. It may be
written explicitly in parameter, field, local, and return annotations as well
as inferred from `attempt`; explicit use materializes the same representation
and does not depend on a throwing call appearing in the same module.

A `.zd` contract may project a conventional native integer status into this
same error model without changing the ABI:

```z
declare module "vendor.h" {
  export function vendor_open(
    out handle: _ | null { deinit vendor_close; }
  ): void throws _ {
    success 0;
  }
}
```

The native return type becomes the inferred error type. A listed status
completes as `void`; any other status is preserved as the failure value.
`try vendor.vendor_open(out handle)` propagates it and `attempt` materializes
`Result<void, NativeStatus>`. This is a tag-only stack value, not an allocated
exception. Owned `out` storage becomes cleanup-active immediately after the
native call and is therefore destroyed even if that call returns failure.

## Enums and matching

Enums may be finite values or carry one typed payload per variant. Construction
uses `Enum.variant(value)`. `match` is exhaustive and uses inverse-constructor
patterns:

```z
const id = match (option) {
  some(user) => user.id;
  none => -1;
};
```

A final bare `_` is an exhaustive catch-all when only selected variants matter:

```z
const title = match (value) {
  string(text) => text;
  _ => "untitled";
};
```

`_` binds no payload and must be the final arm. Arms after it are rejected as
unreachable. A consuming `match (value)` still destroys any owned payload
discarded by the wildcard; `match (in value)` remains non-consuming.

Payload-free Z enums support `==` and `!=` by nominal tag. Payload-bearing
enums require `match`; Z does not implicitly synthesize equality for their
contents.

An expression arm may be concise or use a block with `select value`. `return`
and `throw` always target the enclosing function. `yield` is reserved for
generators rather than overloaded for match blocks.

## Explicit copy, move, and view

Z uses readable prefix keywords when ownership intent should be visible:

```z
const snapshot = copy library.current();
const transferred = move library;
const selected = view library.documents[index];
```

`copy value` produces an independent owned value and leaves its source usable.
The compiler currently synthesizes recursive copies for `String`, fixed and
growable arrays, and Z structs/enums whose entire value graph is copyable.
Cleanup-free values use their ordinary value copy. A `.zd` native value must
explicitly declare `copy`; ARC classes and Objective-C identities do not use
this operator because ordinary assignment already shares their identity.

`move value` transfers an existing unique owner and makes the source binding
unavailable. It applies to cleanup-bearing Z values, ARC owners, and native
values whose contract proves move construction. It is rejected for ordinary
scalars—where there is no unique ownership to transfer—and for `view T`, which
never owns the referenced value. To extract an element from a container, use an
owner operation such as `remove`; moving a field or indexed element directly
would leave a hole in its containing owner.

An owned generic parameter may also be forwarded with `move value`. The
operator consumes that binding inside the generic body; a concrete
ownership-bearing specialization transfers its owner, while a cleanup-free
specialization remains an ordinary by-value pass. This exception is limited to
active type parameters so `move` on a directly known scalar remains an error.

`view projection` creates a read-only, non-owning local projection without
duplicating the value. The owner remains usable for reads, but mutation,
movement, and destruction are rejected until the view's last use. Use `copy`
instead when the result must be independent of the owner.

The keywords are contextual: the ownership forms require whitespace
(`copy value`, `move value`, `view projection`), preserving unambiguous calls
such as `move(value)` or `view(value)` and the existing `move (...) =>` closure
capture syntax.

## Control flow and expressions

`if`, `while`, and `match` parenthesize their subject. Z supports ternaries and
value-producing `if` expressions. Statement blocks never return an implicit
last expression; value-producing blocks use `select` explicitly.

Statement `if`/`else` branches may contain one unbraced statement. `else` binds
to the nearest unmatched `if`. Conditions are always `boolean`; nullable pointers
and references require an explicit comparison with `null` rather than
truthiness.

Imported Objective-C object identity additionally supports the runtime nominal
check `value instanceof NativeClass`. The right operand must be an imported
Objective-C class, and the true branch narrows the left binding to that class.
Nullable `id` evaluates false when it is `null`; no separate null guard or cast
is required:

```zs
const body = message.body;
if (body instanceof Foundation.NSString) {
  const text: String = body;
  consume(text);
}
```

This first tier is intentionally not a general reflection operator: Z classes,
Objective-C protocols, structural traits, and primitive type categories are not
accepted by `instanceof` yet.

`while` and `for...of` may also produce values. A required `else` block handles
natural exhaustion, including a loop that executes zero times. `select` supplies
the loop expression's value and exits it:

```zs
const firstEven: Option<i32> = for (const value of values) {
  if (value % 2 == 0) {
    select Option.some(value);
  }
} else {
  select Option.none;
};

const state = while (attempts < 3) {
  attempts = attempts + 1;
  if (ready()) {
    select "ready";
  }
} else {
  select "exhausted";
};
```

All reachable `select` values and the exhaustion value must have one compatible
type. `continue` begins the next iteration. A plain `break` is invalid in a
value-producing loop because it would leave the expression without a value;
`return` and `throw` still exit the enclosing function. This first executable
tier is synchronous.

Integer arithmetic is checked. Intentional overflow uses explicit wrapping or
saturating operations.

Non-literal numeric types never convert implicitly. Calling the target numeric
type constructs the same mathematical value:

```z
const byte: u8 = 42;
const widened = i32(byte);
const nativeCount = isize(values.length);
const narrowed = u8(widened);
const nativeWidth = f64(narrowed);
```

When the source type's complete range and precision fit the target, this lowers
to a direct native cast. Otherwise Z emits a representability check and traps if
the value would change. Float-to-integer construction rejects fractional,
infinite, NaN, and out-of-range values. Integer-to-float construction rejects
precision loss. Integer literals remain contextually typed and receive a
compile-time diagnostic when they do not fit. `math.trunc` from `std/math`
rounds an `f32` or `f64` toward zero while preserving its floating type; it can
be composed with checked construction when deliberate rounding is desired.
Boolean conversion and implicit widening remain unavailable.

## Collections and views

- `T[N]` is a fixed-size owned array.
- `Array<T>` is an intrinsic growable owned buffer and requires no import.
- `Map<K, V>` is owned associative storage imported from `std/collections`.
- `Set<T>` is owned unique-value storage imported from `std/collections`.
- `Slice<T>` is a non-owning contiguous view.
- `view T` is a read-only projection tied to its owner's inferred lifetime. It
  remains local except for the fixed one-owner value-composite Arena rule.

Indexing is bounds-checked in safe code. Owned elements are destroyed in reverse
initialization order. Mutation that may reallocate requires exclusive mutable
storage. A slice borrow cannot outlive its backing storage or cross a mutation
that invalidates it.

Array-rest destructuring is the narrow local-Slice exception:

```z
let values = Array<i32>(10, 20, 30);
const [first, ...remaining] = view values;
inspect(remaining);
values.push(40); // valid after remaining's last use
```

The Slice descriptor is two words and performs no allocation or cleanup. It is
tied to the named source owner, cannot escape, and prevents moves or
reallocating mutation until its last use.

`Array<T>()` constructs an empty growable array. Values may be supplied directly
without a sequence of `push` calls:

```z
const names = Array<String>("lexer", "parser", "emitter");
const oneNumber = Array<i32>(42);
```

Arguments are evaluated in source order and enter the array under the same
copy/move rules as `push`. The one-argument form contains one element; it does
not reserve capacity. A future capacity operation will have an explicit name.

`Array<T>` supports move-only native C++ values. `push(value)` transfers the
element into the buffer. Growth allocates native storage, move-constructs each
live element into the new allocation, destroys the old elements, and releases
the old allocation. An indexed element is borrowed rather than extractable;
moving the whole array transfers its buffer without relocating its elements.

`clear()` destroys every live element immediately in reverse order and sets
`length` to zero while retaining the allocation and `capacity` for reuse. It
requires addressable mutable `let` storage and is unavailable through
`readonly Array<T>`, a live element view, or an active `for...of` borrow.

A completed collection can permanently surrender mutation without copying its
allocation:

```z
let routes = Map<String, Handler>();
routes.set("open", openHandler);
const handlers: readonly Map<String, Handler> = routes.freeze();
// routes has moved; handlers exposes length, has, get, iteration, and cleanup.
```

`freeze()` consumes named owned `Array`, `Map`, or `Set` storage and returns the
corresponding type-position `readonly` value. The buffer or hash buckets are
transferred unchanged: there is no element copy, allocation, or retain pass at
the freeze boundary. Read operations and iteration remain available; `push`,
`set`, `add`, `remove`, `delete`, `clear`, and a second `freeze` are absent.
There is no implicit thaw. Construct mutable storage, finish initialization,
then freeze at the publication boundary.

The first `Map` API makes ownership visible without exposing its storage:

```z
import { Map } from "std/collections";

let users = Map<String, User>();
users.set("ada", User({ id: 1 }));

const found = users.get("ada");
const id = match (in found) {
  some(user) => user.id;
  none => 0;
};
```

`set` transfers unique cleanup-bearing keys and value types into the map.
Replacing an entry destroys its previous value. For value types, `get` returns
`Option<view V>`, so lookup does not copy or transfer the stored value;
structural mutation is rejected until that view's last use. `remove` returns
owned `Option<V>`. `delete`
destroys the matching key and value and reports whether they existed, while
`clear` destroys every entry. `has` and `.length` do not mutate storage.

Z classes and Objective-C objects instead preserve their shared reference
identity. `set` retains the identity while the caller remains free to use its
own reference, and `get` returns `Option<V>` with an independently retained
reference. `remove` transfers the map's retained reference into `Option<V>`.

Move-only native C++ values use the value contract again: `set` transfers the
owner, `get` returns `Option<view V>`, `remove` move-constructs an owned
`Option<V>`, and replacement, deletion, clearing, growth, and final map cleanup
run the required native moves and destructors. Native keys and copy-only native
values are not supported in the current map tier.

If `V` is cleanup-free and ordinarily copyable, using the matched payload where
an owned `V` is required performs the same implicit by-value load described
above. A cleanup-bearing `view V` never becomes owned implicitly.

Use `copy viewValue` when a cleanup-bearing but recursively copyable value must
become an independent owner. This is an explicit allocation/copy boundary; the
view and its original owner are not consumed.

`Set` uses the same explicit ownership vocabulary:

```z
import { Set } from "std/collections";

let visited = Set<String>();
const inserted = visited.add("settings");
const present = visited.has("settings");
const removed = visited.remove("settings");
const deleted = visited.delete("obsolete");
visited.clear();
```

`add` transfers the value and reports whether it was inserted. If an equal
value is already stored, the existing value remains and the incoming owned
value is destroyed. `remove` borrows its lookup argument and transfers the
stored value through `Option<T>`; ignoring that result destroys it normally.
`delete` destroys the stored value directly and returns whether it existed.
`clear` destroys every stored value, while `has` and `.length` are read-only.

Both collections support direct read-only iteration:

```z
for (const { key, value } of users) {
  console.log(`${key}: ${value.name}`);
}

for (const path of visited) {
  console.log(path);
}
```

A whole Map binding has the displayed type `Map.Entry<K, V>` and exposes
borrowed `.key` and `.value` fields. The same fields may be selected directly by
an object binding pattern. Cleanup-free fields load by value; cleanup-bearing
fields stay borrowed from the entry. A Set binding borrows its stored `T`.
Neither whole elements nor borrowed fields can be moved out, and structural
collection mutation is rejected until the loop ends; use `copy` explicitly when
an independently owned copy is supported. Iteration order is unspecified.

User-defined synchronous iterators implement `Iterator<T>`:

```z
import { Iterator } from "std/iteration";

struct Countdown implements Iterator<i32> {
  current: i32;

  function next(inout this): Option<i32> {
    if (this.current == 0) return Option.none;
    const value = this.current;
    this.current = this.current - 1;
    return Option.some(value);
  }
}

let countdown = Countdown({ current: 3 });
for (const value of inout countdown) {
  console.log(value);
}

for (const value of Countdown({ current: 2 })) {
  console.log(value);
}
```

The explicit `inout` is required for a stored iterator because `next` mutates
its traversal state. A stored value iterator must therefore use `let`; a class
iterator may keep a `const` identity while lending its mutable receiver.
Temporary iterators already have unique compiler-owned storage, so their loop
syntax omits `inout`. Each `some` payload becomes an owned immutable loop
binding and receives normal end-of-iteration cleanup. The stored iterator
survives the loop.

Built-in arrays, slices, maps, and sets keep the borrowed collection semantics
described above and reject `of inout`. Consuming iteration, mutable element
access, cleanup-bearing object-pattern extraction, move-only foreign iterator
elements, and async iteration are not in this tier.

Synchronous generators provide compiler-managed iterator state:

```zs
import { Generator } from "std/iteration";

function noteIdentifiers(count: i32): Generator<i32> {
  let identifier = 1;
  while (identifier <= count) {
    yield identifier;
    identifier = identifier + 1;
  }
}

const identifiers = noteIdentifiers(3);
for (const identifier of identifiers) {
  console.log(identifier);
}
```

The function call returns a cold, move-only `Generator<i32>`; its body starts
when `.next()` or `for...of` first advances it. `.next()` returns `Option<T>`,
and `Generator<T>` satisfies `Iterator<T>` when passed to generic iterator
algorithms.
Stored generators deliberately hide cursor mutation, so a `const` handle uses
plain `of identifiers` rather than the `inout` required by a user-defined value
iterator. Exhaustion, `return;`, and early handle destruction clean every live
suspended local exactly once.

`yield` is what selects suspended-frame lowering. A function returning
`Generator<T>` without `yield` remains an ordinary function and may return or
forward an existing generator value.

Generators may explicitly carry a terminal value with a second type argument:

```zs
struct ScanSummary {
  values: i32;
  total: i32;
}

function scanValues(count: i32): Generator<i32, ScanSummary> {
  let current = 1;
  let total = 0;
  while (current <= count) {
    total = total + current;
    yield current;
    current = current + 1;
  }
  return ScanSummary({ values: count, total });
}

const scanner = scanValues(3);
match (scanner.next()) {
  yielded(value) => consume(value);
  complete(summary) => consumeSummary(summary);
}
```

Here `.next()` returns the compiler-provided
`GeneratorStep<i32, ScanSummary>` enum. `yielded(value)` carries one stream
element and `complete(summary)` carries the terminal return exactly once.
Every reachable path in a two-argument generator must `return` its declared
terminal type. Calling `.next()` again after consuming `complete` is a runtime
contract violation.

`Generator<Yield, Return>` deliberately does not satisfy `Iterator<Yield>` and
cannot be used directly with `for...of`: ordinary iteration would silently
discard `Return`. Advance it explicitly and match both outcomes. The
one-argument `Generator<T>` remains the ergonomic sequence form and continues
to satisfy `Iterator<T>`.

Generator errors occur during advancement, not cold construction:

```zs
struct ReadError {
  code: i32;
}

function readValues(): Generator<i32> throws ReadError {
  yield 20;
  throw ReadError({ code: 7 });
}

const values = readValues();                 // does not execute or throw
const next = attempt values.next();          // Result<Option<i32>, ReadError>
```

Use `try values.next()` inside a function throwing the same error to propagate,
or `attempt values.next()` to retain the `Result`. A fallible handle is written
explicitly as `Generator<Yield, Return, Error>` when it crosses another type
boundary; `void` occupies the terminal slot when there is no terminal value:

```zs
function consume(
  values: Generator<i32, void, ReadError>
): i32 throws ReadError {
  return match (try values.next()) {
    some(value) => value;
    none => 0;
  };
}
```

Direct `for...of` over a throwing generator is rejected until an explicit
propagation form is designed. This keeps generator errors consistent with Z's
rule that throwing work always appears beneath `try` or `attempt`.

The synchronous lowering supports ordinary statements, `if`, `while`, multiple
`yield` points, owned parameters, and owned yielded values. A `for...of` over
`Array`, fixed arrays, `Slice`, `Map`, or `Set` may suspend: its cursor and
borrowed element projection are stored in the generator frame. Statement
`match` may also suspend; payload bindings remain live in the frame and retain
their normal exact-once cleanup semantics. Suspending custom-iterator loops,
value-producing match expressions, generator methods, borrowed parameters or
yielded views, and bidirectional sent values are deferred.

Async generators use the same yield/terminal-result protocol while explicitly
authorizing suspension with `async`:

```zs
import { AsyncGenerator } from "std/iteration";
import { delay } from "std/time";

async function values(): AsyncGenerator<i32, i32> {
  yield 20;
  await delay(1);
  yield 22;
  return 42;
}

async function consume(): i32 {
  const values = values();             // cold: no body execution yet
  const first = await values.next();   // Task<GeneratorStep<i32, i32>>
  const second = await values.next();
  const terminal = await values.next();
  return 0;
}
```

`async` determines which operations are legal in the body; the declared return
shape determines the calling protocol. An ordinary `async function ...: T`
produces a one-shot `Task<T>`. An `async function ...:
AsyncGenerator<Yield, Return>` produces a reusable cold stream handle instead.
Each `.next()` creates one awaited advancement task and resumes the same
persistent frame until the next `yield`, terminal `return`, or `throw`.

Fallible async generators keep cold construction non-throwing and attach the
error to advancement:

```zs
async function rows():
  AsyncGenerator<Row, void, DatabaseError> throws DatabaseError {
  yield row;
  throw error;
}

const rows = rows();
const observed = attempt await rows.next();
```

One-argument, nonthrowing async generators have a natural sequential loop:

```zs
for await (const event of events()) {
  await record(event);
  if (event.complete) break;
}
```

The loop awaits one `.next()` advancement at a time. `continue`, `break`,
`return`, and suspension in the body preserve exact-once yielded-value cleanup.
A temporary stream such as `events()` is owned and destroyed by the loop. A
stored handle remains usable after an early `break`. Async generators with a
terminal return remain explicit `.next()` consumers so the terminal value
cannot be discarded.

A throwing async sequence makes propagation visible on the complete loop:

```zs
async function loadRows(): i32 throws DatabaseError {
  let count = 0;
  try for await (const row of rows()) {
    count = count + 1;
  }
  return count;
}
```

`try for await` accepts `AsyncGenerator<Y, void, E>` and requires the enclosing
async function to declare the same `throws E`. It is the loop equivalent of
`try await stream.next()`: an advancement error ends the loop, cleans the
active yielded value and stream frame exactly once, and propagates `E`.
Nonthrowing streams reject the unnecessary `try`. Local recovery remains
explicit `attempt await stream.next()` so its control flow and partial progress
are visible.

Async iteration also supports object patterns for yielded value structs:

```zs
for await (const { topic: selectedTopic, value } of events()) {
  await record(selectedTopic, value);
}
```

The yielded aggregate is consumed by the loop. Selected owned fields move into
their pattern bindings; unselected fields remain in hidden iteration storage.
Both sets are cleaned exactly once on normal advance, `continue`, `break`,
`return`, propagation, or cancellation. Moving a selected binding again inside
the body transfers that field normally. A yielded struct with custom `deinit`,
native RAII value storage, or opaque foreign cleanup must instead be bound and
moved as a complete value because partial destruction would violate its
contract.

The executable tier supports persistent `if` and `while`, `break` and
`continue`, built-in `Array`/fixed-array/`Slice`/`Map`/`Set` `for...of`
cursors, borrowed `match (in value)` statement payloads, and consuming owned
enum matches across both `yield` and ordinary awaits such as `delay`.
Only the selected arm runs. A value-producing arm may suspend before its final
expression or explicit `select`; `return` and `throw` still exit the enclosing
async function directly:

```zs
return match (lookup) {
  found(job) => {
    const score = await calculate(job.id);
    select job.id + score;
  }
  missing(code) => throw LookupError({ code });
};
```

The enum subject is moved into hidden frame storage exactly once. A whole
payload binding becomes the selected arm's owner; object-pattern fields remain
borrowed from the hidden payload. Live-state cleanup covers normal selection,
`break`, `continue`, return, error propagation, and cancellation. The selected
result may itself own ARC identity, a `String`, a Z value with `deinit`, or
move-only native storage. A directly awaited owned value transfers from its
hidden suspension slot without copying. Async generator methods, async patterns
beyond value-struct object fields, and borrowed parameters/yields remain
explicit follow-up layers.

`Map` and `Set` use open-addressed hashed buckets for amortized O(1) lookup and
membership. Owned entries remain in compact storage, while rehashing moves only
bucket indices; it does not copy or duplicate user-owned values. Built-in
keys/elements include integers, `boolean`, `String`, and payload-free Z or
native enums. Floating-point keys remain excluded because `NaN` does not supply
the required equivalence relation.

Readonly value structs can opt into nominal custom hashing:

```z
import { Map } from "std/collections";
import { Hashable, Hasher } from "std/hash";

readonly struct ProjectKey implements Hashable {
  workspace: String;
  path: String;

  function equals(in other: ProjectKey): boolean {
    return this.workspace == other.workspace && this.path == other.path;
  }

  function hash(inout hasher: Hasher): void {
    hasher.add(this.workspace);
    hasher.add(this.path);
  }
}

let projects = Map<ProjectKey, i32>();
```

The standard `Hashable` requirement conceptually uses
`equals(in other: this)` and `hash(inout hasher: Hasher)`. Equal values must
feed identical components in identical order. `Hasher` owns mixing and final
hash production; implementations feed supported scalars, Strings, enums, or
nested `Hashable` values through `add`. Requiring readonly value keys prevents
mutation from making an inserted bucket unreachable.

`Set<T>` applies the same contract to its element because the stored value is
also the lookup key. The fixed-point compiler supports scalar, String, enum,
and readonly nominal `Hashable` elements across `add`, `has`, `remove`,
`delete`, and `clear`; `remove` transfers the owned element through
`Option<T>`, while `delete` destroys it in place.

`Map` supports ordinary Z values, shared Z-class and Objective-C identity,
ARC-managed function values, and move-only native C++ values. Inserting a
function value retains its callable handle, `get` returns an independently
retained `Option<Handler>`, and `remove` transfers the Map's retained handle.
Replacement, `delete`, `clear`, and Map destruction release stored handlers
exactly once. An owned capturing handler must use a `move` closure because a
borrowed closure cannot escape into collection storage. Weak values, native
keys, and copy-only native C++ values still wait for their distinct storage
rules. A Z value struct may provide an explicit owned wrapper where that is
already safe.

## Ownership-preserving replacement

`std/memory` exports `replace` for exchanging initialized storage while
transferring its previous value to the caller:

```z
import { replace } from "std/memory";

let current = Resource({ id: 1 });
const next = Resource({ id: 2 });
const previous = replace(inout current, move next);
```

The first argument is an exclusive `inout` loan and must name mutable,
initialized storage. The replacement must have exactly the same type. A named
ownership-bearing replacement uses explicit `move`; a freshly constructed
value may be passed directly. The old owner becomes the return value and the
target remains initialized, so both are cleaned exactly once unless moved
again. This is not synchronization: shared cross-thread state must still be
exchanged while protected by `Mutex<T>` or an executor.

The generated operation is a direct native exchange—load the old value, store
the replacement, and return the old value—with no allocation, retain, release,
or copy. Direct ARC class bindings carry their alias identity and local-
uniqueness evidence with the corresponding owner. View-bearing stored values
and aggregates containing nested ARC class references are rejected in the
first tier because exchanging them also requires complete provenance transfer.

## Arena regions

`std/memory` provides the first explicit region allocator without a new keyword
or source-level lifetime parameter:

```z
import { Arena } from "std/memory";

let scratch = Arena({ initialCapacity: 65536 });
const header = scratch.create(Document({ id: 20 }));
const body = scratch.create(Document({ id: 22 }));
const answer = inspect(header) + inspect(body);
scratch.reset();
```

`Arena` is a move-only value owner and therefore uses `let`: both `create` and
`reset` mutate its descriptor. `create(value)` follows ordinary ownership
rules—copyable values may copy while cleanup-bearing and move-only values
transfer—and returns an inferred read-only `view T`. Addresses remain stable,
so later `create` calls are permitted while earlier views are live. A view can
be read directly or passed to a synchronous `in T` parameter.

`reset()` destroys tracked values in reverse creation order, releases all arena
pages, and leaves the arena reusable. Scope exit performs the same cleanup.
Cleanup-free values carry no per-value destructor record; Z `deinit`, ARC
fields, owned native handles, and C++ RAII fields are tracked when present.
Reset, move, and scope destruction are rejected while a view has a later use.
The options object is optional. `initialCapacity` reserves the first page size
and remains a performance hint: the arena is still growable and uses the same
safety and cleanup rules after it adds more pages.

Stage 0 and the fixed-point native frontend implement the same first-tier
contract. Native lowering uses aligned stable pages plus type-specific create
helpers; cleanup-bearing values register one reverse-order cleanup record while
cleanup-free values register none. Selective aliases such as
`import { Arena as Region } from "std/memory";` preserve the same ownership and
runtime behavior.

A local value struct may retain multiple views from one proven owner and then
move directly into that same Arena:

```z
struct Span {
  first: view Coordinate;
  last: view Coordinate;
}

const pending = Span({ first, last });
const stored = scratch.create(pending);
const answer = inspect(stored); // synchronous `in Span`
```

The composite must be an inferred `const`, cannot be copied, and cannot mix
owners. Its `view` fields lower to borrowed pointers and are never destroyed;
any ordinary owned fields still receive normal reverse cleanup. This permits
fixed compiler-shaped relationships without exposing lifetime parameters.

A populated `Array` can collect several such composites when all elements have
that same owner:

```z
const firstSpan = Span({ first, last });
const secondSpan = Span({ first: last, last });
const pendingSpans = Array<Span>(firstSpan, secondSpan);
const spans = scratch.create(pendingSpans);
const answer = inspect(spans[0]);
```

Construction consumes each view-bearing element. The Array is an inferred
`const`, carries one Arena's provenance, and may move only into that Arena.
Its buffer receives normal Arena cleanup, while the view fields remain borrowed
pointers.

A synchronous function can close an Arena and its dependent graph into one
move-only returned owner. The bundle is an ordinary `readonly struct`: it must
declare exactly one direct `Arena` field, while its other fields may contain
views or view-bearing `Array`, `Map`, and `Set` storage proven to come from that
Arena.

```z
struct SyntaxNode {
  kind: i32;
}

struct NodeRef {
  node: view SyntaxNode;
}

readonly struct ParsedFile {
  arena: Arena;
  roots: Array<NodeRef>;
}

function parse(): ParsedFile {
  let arena = Arena();
  const node = arena.create(SyntaxNode({ kind: 42 }));
  const roots = Array<NodeRef>(NodeRef({ node }));
  return ParsedFile({ arena: move arena, roots: move roots });
}
```

Construction is the visible region-closing proof: the named Arena is moved
explicitly, every dependent field must already carry that same Arena identity,
and any old local views into the Arena become unavailable. The completed bundle
can return across module boundaries, move into an owned synchronous parameter,
or be inspected through `in ParsedFile`. Field projections inherit the bundle
as their owner, so the internal views remain valid for exactly as long as the
bundle remains live. Dependent fields are destroyed before the Arena regardless
of declaration order. The bundle itself adds no heap allocation, retain, or
runtime provenance tag: both emitters lower it to an ordinary C value struct
containing the Arena descriptor and dependent owners.

The first closed-region tier deliberately rejects mutable bundle fields,
multiple direct Arenas, mixed owners, struct spread, nesting the bundle inside
another owner or collection, closure capture, generators, and async suspension.
Those are separate provenance relationships rather than reasons to weaken the
safe synchronous return path.

An empty `let` Array starts without provenance. Its first consuming `push`
establishes the owner, and every later element must come from that Arena:

```z
let spans = Array<Span>();
spans.push(Span({ first, last }));
spans.push(secondSpan);
const stored = scratch.create(spans);
```

The first push may also appear in exhaustive `if` or `match` branches when every
continuing path establishes the same Arena:

```z
let spans = Array<Span>();
if (preferPrimary) {
  spans.push(primarySpan);
} else {
  spans.push(fallbackSpan);
}
```

A missing branch or a branch using another Arena is rejected at the join. A loop
body cannot establish provenance because it may execute zero times. Once
provenance is established, later same-owner pushes may occur in control flow.
`push` remains forbidden while an element view or iteration loan is live because
growth can relocate the buffer.

An enum may carry one region edge in variants that contain a named one-owner
view-bearing value struct, while alternatives such as `none` carry no active
edge:

```z
enum StoredSpan {
  primary Span,
  none,
}

struct Node {
  span: StoredSpan;
}

const pendingSpan = StoredSpan.primary(Span({ first, last }));
const pending = Node({ span: pendingSpan });
const node = scratch.create(pending);
const active = node.span;

return match (in active) {
  primary(span) => inspect(in span);
  none => 0;
};
```

The payload constructor consumes its payload and the active enum value inherits
that payload's single Arena identity. An ownerless constructor records that no
region is currently reachable. The enum may nest through value structs;
owner-bearing values can be stored only in their Arena, while a proven
ownerless value can be stored in any Arena. `match (in value)` is required and
gives the direct payload binding the same provenance for the arm.

`if` and `match` expression joins use a small provenance lattice: ownerless plus
Arena A becomes conservatively Arena A, two Arena A paths remain A, and Arena A
plus Arena B is rejected. This is compile-time flow evidence, not a runtime tag
or reference-counted region handle. The first tier still rejects direct
`view T` payloads, mixed-owner payloads, object destructuring, copying,
consuming matches, mutation, escape, and suspension.

Recursive Arena graphs use `Option<view T>` for a nullable same-region edge:

```z
struct Node {
  value: i32;
  next: Option<view Node>;
}

const tail = scratch.create(Node({
  value: 22,
  next: Option<view Node>.none,
}));
const head = scratch.create(Node({
  value: 20,
  next: Option<view Node>.some(tail),
}));
```

`none` is ownerless. `some(tail)` consumes no pointee; it records the same Arena
provenance as `tail`, making `head` storable only in `scratch`. Only a proven
borrowed view may enter this Option. The runtime representation is exactly one
nullable pointer in both compiler frontends, so inspection adds no tag or ARC
traffic.

A mutable local `Map<K, V>` or `Set<T>` can establish the same single-Arena
provenance when its stored view-bearing value is a named value struct:

```z
let symbols = Map<String, SymbolLink>();
symbols.set("main", SymbolLink({ declaration }));
const storedSymbols = scratch.create(symbols);
```

For a Set, `T` must additionally be readonly and implement `Hashable`; its
`equals` and `hash` methods may inspect the embedded views synchronously. The
first `set` or `add` fixes the collection's Arena owner; later values and the
eventual `Arena.create` transfer must agree. `Map.get` returns `Option<view V>`
into Map storage and therefore loans the Map against structural mutation.
Empty view-bearing Maps and Sets require `let`; direct view values, mixed
owners, and first insertion inside a loop are rejected. Native fixed-point
lowering covers the complete hashed mutation surface for both shapes.
`Map.get` uses the nullable view niche; `Map.remove` and `Set.remove` return
tagged owned Options whose Arena proof follows the transferred value. `delete`
destroys one match and returns `boolean`; `clear` destroys all entries but
retains allocated storage and the established Arena proof for compatible reuse.

The first region tier is synchronous and single-threaded. Arena views cannot be
returned, captured by stored or escaping closures, passed as owned or mutable
values, or held across `await`. View-bearing composites additionally cannot
enter classes; ordinary collection storage is limited to compatible-owner
Arrays, Map values, and Set elements, enum storage is limited to the variant-sensitive
one-owner rule above, and recursive edges are limited to same-Arena
`Option<view T>`. Their
only eventual owning destination is their provenance Arena. A synchronous
inline closure accepted through an `in`
function parameter may read the view and ends its loan when the call returns.
Direct class/reference-identity roots are excluded, although an arena-owned
value struct may contain ARC fields. Allocation failure currently traps.
Loop-carried establishment, broader recursive enum graphs, async
regions, thread transfer, page reuse, and allocator parameters remain later
tiers.

## Generics and traits

Generics use TypeScript-shaped angle brackets and are monomorphized for native
values. Call sites infer type arguments from ordinary arguments where possible.
Multiple nominal constraints use intersections:

```z
function describe<T: Measured & Named>(in value: T): String { ... }
```

Traits may also be generic. `trait Source<T>` describes a family of nominal
contracts, and `implements Source<i32>` is checked against that concrete
specialization. A constraint may name the same specialization:

```z
trait Source<T> {
  function next(inout this): Option<T>;
}

function inspect<T: Source<i32>>(inout source: T): i32 {
  return match (source.next()) {
    some(value) => value;
    none => 0;
  };
}
```

Generic traits remain statically dispatched. The fixed-point compiler
specializes a constrained generic for its concrete argument and emits a direct
call to that concrete method; it does not allocate a trait object or consult a
vtable. The concrete demand may originate in another module, including a
private downstream type: the specialization remains owned by the generic's
declaring module while its semantic type identity and cleanup contract come
from the consumer. This works for generic free functions and independently
generic methods. Z does not yet provide trait-typed storage or
existential/dynamic dispatch.

Transparent aliases name an existing type without changing representation,
ownership, ABI, or assignability:

```zs
export type Operation = (left: i32, right: i32) => i32;
type Values = Array<i32>;

function apply(operation: Operation, left: i32, right: i32): i32 {
  return operation(left, right);
}
```

Aliases may be exported and imported selectively or through a namespace.
Construction and static lookup through an aggregate alias resolve directly to
the underlying aggregate. Alias chains are supported, while recursive cycles
are compile-time errors. Generic alias declarations such as `type Lookup<T> =
Map<String, T>` remain deferred. An alias is not an opaque type or newtype and
therefore adds no conversion or runtime boundary.

Methods may introduce type parameters independently of their owner. Arguments
are inferred at the call site or supplied explicitly:

```z
struct Slot {
  occupied: boolean;

  function choose<T>(primary: T, fallback: T): T {
    if (this.occupied) return primary;
    return fallback;
  }
}

struct Utility {
  static function preserve<T>(value: T): T { return value; }
}

const inferred = slot.choose(20, 22);
const explicit = Utility.preserve<i32>(42);
```

When arguments do not mention every type parameter, a direct call may use its
result contract as inference evidence. Local annotations, assignment targets,
and enclosing function returns provide that context:

```z
function absent<T>(): Option<T> { return Option<T>.none; }

const local: Option<i64> = absent();

function load(): Option<i32> {
  return absent();
}
```

An unannotated `const local = absent();` remains ambiguous and requires either a
destination type or explicit type arguments. Context narrows inference; it does
not create a default generic argument.

An instance of a generic owner may also call a separately generic instance
method. A static method whose owner and method both introduce independent type
parameters is deliberately deferred until that two-level specialization syntax
is designed. The fixed-point compiler demand-specializes direct generic free
functions and executes independently generic instance methods on concrete
generic value structs plus independently generic static or instance methods on
non-generic owners. It also materializes demand-driven generic ARC classes with
synthesized object initialization, specialized ordinary instance methods,
atomic retain/release, custom `deinit`, and automatic cleanup of concrete owned
fields. Custom constructors, weak-reference lowering, and class-field defaults
for those specializations remain staged. Inferred and explicit calls share one concrete body;
cross-module aliases preserve the declaring module's identity, and ordinary
ownership-bearing results and typed `throws` keep their existing semantics.
Calls from one generic free-function body into another recursively propagate
their concrete demand, including across module boundaries. Method lowering keeps
the owner's substitutions separate from the method's own inferred or explicit
substitutions.

`|` is reserved for union-like type composition; it is not the spelling for
requiring multiple trait conformances.

## Closures and function values

Arrow closures follow TypeScript-shaped parameter and return syntax. Captures
borrow by default. `move` creates an owned capture when a closure must escape:

```z
const deferred: () => i32 = move () => resource.value;
```

A read-only `view` may be captured only where the destination proves that the
closure cannot escape:

```z
const item = store.at(0);
const observed = inspect(() => item.value); // inspect takes `in operation`
store.append(next);                         // valid after inspect returns
```

Owned closure environments use ARC. Noncapturing closures can lower directly to
native function pointers where the foreign ABI permits it. `weak` captures may
break class/closure cycles.

Function types carry their error effect:

```z
struct DecodeError {
  code: i32;
}

type Decoder = (bytes: Slice<u8>) => Message throws DecodeError;

function decode(in operation: Decoder, bytes: Slice<u8>): Message throws DecodeError {
  return try operation(bytes);
}
```

A named throwing function or a closure with the same signature can initialize
`Decoder`. When a destination function type supplies `throws DecodeError`, the
closure body is checked in that error context, so it may use `throw` without
repeating the effect on the literal. An unconstrained closure can spell the
effect explicitly as `(bytes: Slice<u8>): Message throws DecodeError => { ... }`.
Calling either form still requires `try` or `attempt`; function values do not
erase error handling. The error type is part of the function type and ABI.

Nested closures forward free captures automatically:

```z
const save = move (): void => {
  const control = scope.schedule(thread.main, async move (): void => {
    const worker = thread.spawn(async move (): void => {
      await on thread.main {
        presenter.saved();
      }
    });
    await worker;
  });
  if (!control.accepted) presenter.closing();
};
```

`presenter` is captured through every intervening closure without relay
bindings. Each boundary still applies its own rules: borrowed closures cannot
escape, escaping closures require `move`, native-thread captures must be
transferable, and executor-isolated identity remains opaque outside its
executor placement. Parameters and locals in an intervening closure shadow
outer names normally.

## Strings and console

`"text"` and `'text'` are ordinary string literals. Backticks are template
strings and use `${expression}` interpolation. `String` is an owned UTF-8 value;
`cstring` is a borrowed native C string view. The standard console is explicit:

```z
import console from "std/console";
console.log(`answer=${answer}`);
```

String storage operations name their unit explicitly:

```z
const source = "export function main() {}";
const bytes: usize = source.byteLength;
const first: u8 = source.byteAt(0);
const keyword = source.copyBytes(0, 6);
if (source.isEmpty) console.log("empty source");
```

`byteAt(index)` checks its index. `copyBytes(start, end)` uses a half-open range,
creates an independently owned `String`, and checks both bounds and UTF-8
boundaries. Binary-facing code and internal text slicing should use these
explicit byte operations. `String.length` is reserved for a Unicode
grapheme-counting text API; it is not implemented by treating UTF-8 bytes or
JavaScript UTF-16 code units as characters. `byteLength` is constant-time; the
eventual grapheme-aware `length` may require a text scan.

Public source locations deliberately use one-based lines and columns plus
zero-based UTF-16 code-unit offsets. UTF-16 is a protocol coordinate—not Z's
text representation or character model—and matches LSP/VS Code plus the
bootstrap compiler. Native frontend code keeps a separate UTF-8 byte cursor for
`copyBytes`; it must not use public source offsets to slice a `String`.

`String == String` and `String != String` compare exact UTF-8 byte sequences.
Equality performs no locale folding, Unicode normalization, or JavaScript-style
coercion. Comparing text from different normalization domains therefore remains
an explicit text-processing operation.

Repeated text construction uses the explicit `std/text` value type rather than
repeatedly allocating intermediate `String` values:

```z
import { TextBuffer } from "std/text";

let output = TextBuffer();
output.append("answer=");
output.appendBytes(source, start, end);
output.appendAscii(10);
output.appendCodePoint(128640); // U+1F680 ROCKET
const text = output.finish();
```

`TextBuffer` is move-only mutable construction storage. It must be bound with
`let` before appending, cannot be logged as if it were completed text, and
`finish()` consumes it into an immutable owned `String`. `appendBytes` uses a
checked half-open byte range and requires both offsets to be UTF-8 boundaries;
`appendAscii` accepts only the ASCII range. `appendCodePoint` accepts a checked
Unicode scalar value, rejects surrogate and out-of-range values, and encodes it
as UTF-8. The explicit import keeps this specialized construction API out of
the language prelude.

## JSON values

JSON is an explicit source-backed standard module rather than a compiler-global
object:

```z
import json from "std/json";

function read(in source: String): String throws json.JsonError {
  const value = try json.parse(source);
  return json.stringify(in value);
}
```

`JsonValue` is an owned recursive enum with `nullValue`, `boolean`, `number`,
`string`, `array`, and `object` variants. Its number payload is the nominal
`JsonNumber`, not `f64`: parsing preserves the validated source spelling, and
stringification therefore forwards arbitrarily large integers, decimals, and
exponents without rounding. Dynamic consumers choose an explicit checked
conversion through `toU64()`, `toI64()`, or `toF64()`; `text()` returns an owned
exact spelling. Validated construction is available through `JsonNumber.parse`,
`fromU64`, `fromI64`, and finite `fromF64`. The stored spelling is private, so
ordinary Z code cannot manufacture an invalid number representation.

Arrays own their elements and objects own `Map<String, JsonValue>` entries, so
ordinary `move`, `in`, matching, and deterministic cleanup rules apply. `parse`
accepts exactly one JSON value, decodes Unicode escapes into UTF-8, limits
nesting, and throws `JsonError` with zero-based byte `offset` plus one-based
`line` and `column`. `stringify` emits compact JSON and borrows the complete
value graph while retaining each number's original spelling.

For application data, Stage 0 and the native compiler derive a codec directly
from an ordinary Z value struct:

```z
struct User {
  id: u64;
  name: String;
  active: boolean = true;
  tags: Array<String>;
}

function readUser(in source: String): User throws json.JsonError {
  const user = try json.decode<User>(source);
  const encoded = json.encode(in user); // T is inferred as User
  return user;
}
```

The derived encoder and decoder support public, non-optional `String`,
`boolean`, signed or unsigned integer, nested value structs, and arrays of
strings or those structs, including `readonly Array<T>` and recursive trees
whose recursion passes through an array. `Option<T>` fields can wrap any of
those supported field types. JSON `null` maps to `none`; a non-null value maps
to `some(value)`. Encoding a `none` field writes `null`, rather than omitting
the key. Missing fields are still errors unless the field declares a default:

```z
struct Request {
  directory: Option<String>; // required key; null is allowed
  label: Option<String> = Option<String>.none; // omission uses this default
}
```

Nested `Option<Option<T>>` is rejected because JSON `null` cannot distinguish
`none` from `some(none)`. Arrays of Options remain a later codec tier; arrays of
structs that contain Option fields are supported. The decoder parses integers directly
into their requested Z width, so even `u64.max` does not require a dynamic intermediate value.
Missing fields with defaults evaluate those defaults; other missing fields
throw `JsonError`. Unknown fields are skipped recursively, duplicate known
fields are rejected, names match exactly, and encoding follows declaration
order. Source field names remain the JSON keys even when generated C must use
an internal name for fields such as `signed` or `unsigned`; that spelling change
adds no runtime work. Classes, custom constructors or `deinit`, optional property syntax (`?`),
floating-point fields, other collections, and field-name policies remain later
derived-codec tiers.
`json.parse` / `json.stringify` remain the implemented dynamic route for those
shapes. Stage 0 and the fixed-point native compiler materialize the same direct
streaming codecs without an intermediate dynamic JSON tree.

## Files, processes, and program arguments

System facilities are explicit standard-module imports. File operations and
child launch use ordinary Z typed errors; `try` propagates them and `attempt`
materializes their `Result` for local handling:

```z
import console from "std/console";
import fs from "std/fs";
import process from "std/process";

function stage(in path: String): i32 throws String {
  const cacheLock: fs.Lock = try fs.lock(".z-cache/build.lock");
  const source = try fs.readText(path);
  const bytes = try fs.readBytes(path);
  try fs.createDirectories(".z-cache");
  try fs.writeText(".z-cache/input.zs", source);
  try fs.writeText(".z-cache/output.pending", source);
  try fs.replace(".z-cache/output.pending", ".z-cache/output.zs");
  cacheLock.unlock(); // optional early release; scope exit also releases it
  console.log(`read ${bytes.length} raw bytes`);
  const clangArguments = ["--version"];
  return try process.run("clang", clangArguments);
}
```

`fs.readText(path)` returns an owned UTF-8 `String`; `fs.readBytes(path)`
returns an owned `Array<u8>` without text decoding; `fs.writeText(path,
contents)` borrows both strings for the call; `fs.exists(path)` performs a
non-throwing existence probe; and `fs.isDirectory(path)` distinguishes an
existing directory from a file or missing path. `fs.createDirectories(path)`
creates every missing parent, succeeds when the complete directory already
exists, and throws if an existing component is not a directory or the
operating system rejects creation. `fs.realPath(path)` returns an owned
canonical absolute path, resolving relative components and filesystem links,
or throws a typed `String` OS failure. Returned paths and text contents must be
valid UTF-8; `readBytes` deliberately accepts arbitrary file bytes.
`fs.lock(path)` blocks the current OS thread until it owns an exclusive
interprocess lock associated with that file. Its move-only `fs.Lock` result
releases the operating-system lock deterministically on scope exit, including
error propagation and early `return`. Calling `lock.unlock()` releases it
earlier and consumes the owner, so a later use or second unlock is a compile
error. The lock file may remain on disk; process termination still releases the
kernel lock, so this is not a stale lock-file protocol. This primitive protects
cross-process artifacts. The current `std/sync` `Mutex<T>` tier provides
scoped synchronous in-process mutual exclusion; `RwLock<T>`, public guards,
atomics, condition variables, and semaphores remain later tiers. `Once<T>`
serializes publication and retrieval of main-lifecycle application identity;
it does not protect mutable fields inside that identity, which still belong
behind `Mutex<T>` or an executor contract.

`fs.replace(source, destination)` publishes a completely written artifact with
one atomic same-filesystem directory-entry replacement. On success the source
path disappears and an existing destination names the source contents. It
throws a typed `String` OS failure rather than silently copying across
filesystems. Atomic replacement prevents a partial-file observer; callers that
need persistence across abrupt power loss still require a future explicit
durability/synchronization API.

`process.args()` returns an owned `Array<String>` containing
the arguments after the executable name. `process.run(program, arguments)`
borrows a stored fixed array or `Array<String>` as a non-escaping
`Slice<String>`, launches the executable directly without a shell, inherits the
parent standard streams, and returns its exit code. Failure to launch or wait is
a typed failure; a child program's nonzero exit is a successful `i32` result.
`process.executablePath()` returns the canonical absolute UTF-8 path of the
currently running executable or throws a typed operating-system `String`
failure. It is intended for locating resources and helper tools distributed
beside an application; it does not expose the compiler host's executable.
`process.args()` and `process.executablePath()` currently require an executable
target, because only Z `main` receives and installs the process argument vector.
Static and shared libraries receive a source diagnostic; their host should pass
required arguments through an explicit `export c function` until an embedding
argument contract is designed.

`z run file.zs -- one two` forwards `one` and `two` to the native program.
Stage 0 and the fixed-point native compiler lower their supported portions of
these APIs to a small cross-platform C runtime. The portable standard-library
layers are intended to become ordinary Z modules; OS/ABI calls remain a thin
platform substrate. The exact native-compiler subset is tracked in
[`bootstrap-status.md`](bootstrap-status.md).

## Async and structured concurrency

`async function` returns a task conceptually, while `await` observes its
completion. `task` starts child work immediately. Every child task belongs
to a lexical task scope; an async function body is an implicit root scope and an
`async scope` creates a narrower join boundary.

```z
async function refresh(): void throws NetworkError {
  async scope {
    task refreshUser();
    task refreshPosts();
  }
  publishRefreshedUI();
}
```

Leaving a scope joins its children. Failure propagation cancels live siblings
before the failing task completes. Domain errors remain `T throws E`;
cancellation is a structural task outcome, not an invented member of `E`.

Code performing long synchronous chunks inside an async task can cooperate
with its current executor explicitly:

```z
import { scheduler } from "std/async";

async function index(in records: Array<Record>): void {
  for (const record of records) {
    indexRecord(record);
    await scheduler.yield();
  }
}
```

This requeues the current task and creates a cancellation-observation point. It
does not create a timer, switch executors, or produce a generator value.

A scope can optionally expose its compiler-owned handle:

```z
import { TaskControl, TaskScope } from "std/async";
import { thread } from "std/thread";

async scope updates {
  registerNativeCallback(move (value) => {
    const control: TaskControl = updates.schedule(
      thread.main,
      async move (): void => {
        const worker = thread.spawn(async move () => calculate(value));
        publish(attempt await worker);
      }
    );
    if (!control.accepted) reportClosing();
  });
} // rejects new submissions and joins every accepted operation
```

The unnamed form retains its allocation-free static lowering when all children
are lexically visible. `async scope updates {}` binds `updates: TaskScope` for
dynamic submission by callbacks. `TaskScope.schedule` returns a `TaskControl`;
its `accepted` property is `false` if close has won the submission race. The
explicit form is `new TaskScope()`, followed by
direct `await scope.close()` or `await scope.cancel()` when an earlier boundary
is useful. Its owning async function otherwise closes it on return and cancels
it on throw. `TaskScope` owns lifetime; `thread.main` selects placement.
`schedule` accepts nonthrowing synchronous `(): void` or explicitly async
`async (): void` operations. An async operation can suspend and start
structured children. It handles fallible work locally with `attempt await`;
there is intentionally no unobserved error channel back to the synchronous
submitter. The scheduled closure receives proof for the executor passed to
`schedule`; in the current tier that executor must be `thread.main`.

An escaping `.zd` callback or Objective-C block declared `thread any`
automatically enters the Z runtime captured at registration for the duration of
callback invocation and native release. This includes block APIs surfaced by a
generated Swift Objective-C header and enables synchronized application-root
lookup and ARC cleanup without a manual attach call. The callback is still
synchronous and off-main: it uses `TaskScope.schedule(thread.main, ...)` for
structured UI work rather than calling main-isolated members directly or
awaiting in place.

### Task, TaskScope, and TaskControl

These types deliberately expose different kinds of authority:

| Surface | Created by | Owns completion/join? | Carries a value or typed error? | Cancellation |
|---|---|---:|---:|---|
| Direct `await operation()` | Async call | Current task waits directly | Yes | Parent cancellation propagates structurally |
| `Task<T, E>` | `task operation()` or `thread.spawn(...)` | Yes, for one child; `await` consumes the join handle | Yes | `await task.cancel()` requests cancellation and joins |
| `TaskScope` | `async scope name {}` or `new TaskScope()` | Yes, for every accepted dynamic operation | No per-operation result | `await scope.cancel()` cancels and joins the entire scope |
| `TaskControl` | `scope.schedule(...)` | No; the scope remains the sole join owner | No | `requestCancel()` requests cancellation of only that operation |

`TaskControl` is a shared, cleanup-bearing identity rather than a second task
handle. It may be stored in an `Option<TaskControl>` or ARC-managed controller
for UI cancellation:

```z
const save = updates.schedule(thread.main, async move (): void => {
  const result = attempt await persist(note);
  publish(result);
});

if (!save.accepted) {
  showClosing();
  return;
}

// A later callback may request cancellation without taking join ownership.
if (save.requestCancel()) showCancelling();
```

`requestCancel()` returns `true` only for the first accepted request while the
operation is still live. It returns `false` when scheduling was rejected, the
request was already made, or the operation has completed.
`isCancellationRequested` reports whether this control issued a request; it is
not a completion flag. Dropping a `TaskControl` does not detach or cancel work.
The owning `TaskScope` still rejects, cancels, and joins safely at its boundary.

CPU work that must leave the inherited executor uses the explicitly imported
native-thread launcher:

```z
import { thread } from "std/thread";

const calculation = thread.spawn(move () => calculate(input));
doOtherWork();
const answer = await calculation;

const fallible = thread.spawn(move (): i32 throws CalculationError => {
  const value = try calculateOrThrow(input);
  return value;
});
const result = attempt await fallible;

const threadAffine = thread.spawn(async move (): i32 throws CalculationError => {
  const value = try await on thread.main: i32 throws CalculationError {
    select try await calculateForMain(input);
  };
  return value;
});
const published = try await threadAffine;
```

This is distinct from keyword `task`: `task operation()` schedules an async
child on the current executor, while `thread.spawn(operation)` starts exactly
one OS thread. A synchronous closure runs once; an explicitly `async` closure
owns a private executor bound to that worker, may suspend, and resumes on the
same worker after `await on thread.main`. Child `task` operations inherit the
worker executor. The transfer classifier copies recursively cleanup-free
values, moves unique owners, and retains deeply readonly ARC class identity
atomically. A main-isolated Z class may instead cross opaquely: the worker can
use it only in a nested main placement, and its transferred retain is released
on main. A capturing closure must spell `move`. Copy and shareable ARC captures
remain valid in the parent; moved unique owners do not. `Array`, owned `String`,
mutable `TextBuffer`, and supported aggregates containing them use the
consuming path and may return ownership through `await`. Other mutable classes,
borrows, views, raw native references, `Arena`, custom `deinit`, and
cross-thread `Weak<T>` remain rejected. Results follow the same rules.

The thread namespace also supplies typed placement targets. The first target is
`thread.main`:

```z
const direct = await on thread.main refreshUI(model);
const directChild = task on thread.main loadUI(model);
const updated = await on thread.main using (in model) {
  select refreshUI(model);
};
const child = task on thread.main using (move work) {
  consume(move work);
};
```

`await on` hops and waits, while `task on` creates a hot structured child on
main. A direct call uses its declared parameter capabilities; block placement
is for anonymous multi-statement work and uses lexical captures. A contextual
`using (in value, inout state, move owner)` clause makes ownership-bearing
captures explicit without repeating their types. Cleanup-free recursively Copy
values and owned String snapshots may be omitted and become private copies.
`in` is read-only access until join, `inout` is an exclusive mutable loan until
join, and `move` consumes the source binding. A borrowed `task on` capture
requires an enclosing `async scope`; direct `await on` already joins it. `out`
capture is reserved for a later definite-initialization tier. Value-storage
`inout` requires `let`; a `const` ARC class reference may use `inout` to invoke
mutable instance behavior because binding immutability and object mutation are
separate. Async direct
calls schedule the callee frame itself, so their result is `T`/`Result<T, E>`
when awaited or `Task<T, E>` when forked—never a nested task. Code already
proven to run on main accesses isolated state directly; there is no bare
`on thread.main { ... }` proof block. A native worker can
create a placed main child without blocking main; Darwin wakes the executor
through a CFRunLoop source. A placement used as a statement is a block statement
and does not require a trailing semicolon; bindings and other value expressions
still do. Other ownership shapes and platform UI-loop adapters remain bounded
work. See
[`executor-placement.md`](executor-placement.md).
The returned task remains scope-bound and is joined explicitly by `await` or
implicitly at scope exit.

Awaited operations can suspend inside an awaited placement:

```z
const updated = await on thread.main {
  select await refreshUI();
};
```

The outer `await` joins the executor placement. The inner `await` is the
operation performed on that executor. Its continuation retains main-executor
proof; after the placement completes, a native-worker caller resumes on its
original private executor.

The current fixed-point slice can execute ordered main segments around more
than one timer suspension:

```z
async function publish(value: i32): i32 on thread.main {
  let progress = beginLoading(value); // main segment 1
  await delay(10);                    // cancellable worker wait
  progress = refreshWindow(progress); // main segment 2
  const result = finishWindow(progress);
  await delay(10);                    // cancellable worker wait
  return result;                      // final main segment
}
```

One top-level braced conditional may instead own the suspensions:

```z
async function publish(value: i32, refresh: boolean): i32 on thread.main {
  let progress = value;
  if (refresh) {
    progress = beginRefresh(progress);
    await delay(10);
    progress = finishRefresh(progress);
  } else {
    await delay(1);
    progress = keepCurrent(progress);
  }
  return progress;
}
```

One top-level statement match may do the same. This first example uses
cleanup-free payloads:

```z
enum Direction {
  increase i32,
  decrease i32,
  unchanged,
}

async function publish(value: i32, direction: Direction): i32 on thread.main {
  let progress = value;
  match (direction) {
    increase(amount) => {
      progress = beginRefresh(progress, amount);
      await delay(10);
      progress = finishRefresh(progress);
    }
    decrease(amount) => {
      await delay(10);
      progress = removeRefresh(progress, amount);
    }
    unchanged => {
      await delay(1);
    }
  }
  return progress;
}
```

An owned payload uses the same source shape. The match consumes its enum
subject, and returning `message` transfers the payload out:

```z
enum Delivery {
  publish String,
  idle,
}

function ownedText(in value: String): String {
  return value.copyBytes(0, value.byteLength);
}

async function forward(delivery: Delivery): String on thread.main {
  match (delivery) {
    publish(message) => {
      await delay(10);
      return message;
    }
    idle => {
      return ownedText("");
    }
  }
}
```

The subject may also be computed. It still runs exactly once; its owned result
is adopted directly by the invocation frame:

```z
match (Delivery.publish(ownedText("ready"))) {
  publish(message) => {
    await delay(10);
    return message;
  }
  idle => return ownedText("");
}
```

The fixed-point native compiler currently implements an honest, bounded
suspending-callee state machine. A main-isolated callee may contain multiple
top-level literal `await delay(...)` statements with synchronous expression
statements before and between them, one top-level braced `if`/`else`, or one
top-level statement `match` over a consuming enum-valued expression with
braced arms. It may instead contain one top-level braced `while` with direct
literal delays. The loop condition is reevaluated on main for every iteration;
synchronous body segments execute on main, while repetition and cancellable
waits remain on the worker. `break` exits and `continue` begins the next
condition check, including deterministic cleanup of live iteration-local
owners. `return` and `throw` complete the enclosing callee from any supported
synchronous loop segment, transfer its success or typed failure to the worker,
and run ordinary ownership cleanup first. Direct synchronous `try` bindings,
assignments, and expression statements propagate through that same typed
completion path. Successful cleanup-bearing values can cross the next wait in
the existing frame without cloning. Scalar, plain-struct, and cleanup-bearing
payload bindings are supported. A cleanup-bearing match must consume its
subject with `match (value)`. A stable
named owner transfers into the frame, while a computed call or constructor
result is adopted there directly. Its active payload moves between the
invocation frame and selected arm binding without cloning. The
structured branches contain direct literal delays. The direct placed call must
be the worker closure's tail return. A condition or match subject executes once
on main and only the selected branch or arm waits. Main executes each
synchronous segment; every delay waits cancellably on the worker, never on
main. Success, owned results,
typed failure, cancellation, and main-thread cleanup of transferred arguments
are executable in that tier. Initialized top-level locals and direct local
assignments live in one heap-owned invocation frame. Cleanup-bearing locals
carry explicit liveness, can move into later locals or the final result without
duplication, and are destroyed on main when cancellation wins. Branch-local
owned values use the same frame liveness and deterministic cleanup. Parameter
writes or unrelated ownership transfers, borrowed cleanup-bearing match
subjects, suspending `for` loops, nested loop/match, `try await`, or nested
try-value normalization across a suspending `while`, nested suspending control
flow, combining an outer
delay sequence with
a structured suspension, a computed delay duration, or code after the placed
call fails closed in native lowering for now. Stage 0 retains the broader async
surface described above.

Executor-isolated declarations place the contract after the declaration
signature and before the body:

```z
class NotesController on thread.main { /* ... */ }
struct WindowState on thread.main { /* ... */ }
function updateWindow(): void on thread.main { /* ... */ }
```

Stored fields use the same suffix after their type:

```z
class Application {
  readonly name: String;
  readonly state: Mutex<ApplicationState>;
  window: AppKit.NSWindow on thread.main;

  function revision(): i32 { /* any-thread synchronized read */ }
  function show(): void on thread.main { /* may access window */ }
}
```

The isolated field makes construction and destruction main-bound without
automatically isolating every member. An unannotated field is accessible
off-main only when it is readonly and transitively thread-safe; mutable or
non-shareable fields are conservatively main-only. Unrestricted methods are
checked without main proof and bare `this` cannot escape from them. A whole
`class Application on thread.main` remains wholly isolated.

For a long public return contract, prefer a semantic type alias so the executor
requirement remains easy to scan:

```z
type LoadNotesResult = Result<Map<String, Array<Note>>, StorageError>;

function loadNotes(): LoadNotesResult on thread.main { /* ... */ }
```

An isolated aggregate establishes main proof inside all of its methods and
lifecycle bodies. A struct or class that stores an isolated aggregate inherits
that affinity transitively; hover shows the originating type and field path.
Calls, construction, member access, and cleanup must remain on main. The
current async tier requires an explicit `await on thread.main` hop rather than
automatically scheduling an isolated async function.

Native declarations use the same contract. Explicit Clang
`swift_attr("@UIActor")` and `swift_attr("@MainActor")` facts automatically map
to `thread.main`. Swift-generated Objective-C headers omit the source
`@MainActor` attribute, so a Swift target declared in `z.json` also emits a
compiler-consumed symbol graph; its actor-isolated Objective-C types and methods
enter the same FIIR fact automatically. A reviewed `.zd` fallback handles
external, legacy, or incompletely annotated surfaces:

```z
declare module "LegacyUI.h" {
  export type LegacyWindow on thread.main;
  export function LegacyWindow.refresh(): _ on thread.main;
}
```

Native affinity appears in class, binding, property, method, and function hover.
A Z aggregate that stores an isolated native identity inherits the same
affinity. The ABI call remains direct; the contract adds compile-time placement
and transfer checks rather than a runtime wrapper.

Throwing worker closures return `Task<T, E>`; `try await` propagates `E` and
`attempt await` produces `Result<T, E>`. Error slots have the same explicit
liveness as result slots, so transferable String/Array ownership, containing
aggregates, readonly ARC identity, and contracted native owners are moved or
shared according to the ordinary thread classifier and destroyed exactly once.
Synchronous worker bodies may use `const value = try operation();`, direct
`return try operation();`, or `attempt operation()` followed by `match`.

## Native interop

Native declarations come from toolchain-owned headers and module interfaces.
Z's foreign semantic model adds facts absent from those declarations: ownership,
nullability, lifetime, callback retention, threading, and async behavior.
Those facts normalize through the
[`Foreign Interface IR`](foreign-interface-ir.md) before semantic checking.

### Unsafe native calls

`unsafe { ... }` keeps Z syntax and types while accepting a local,
unverified native proof:

```z
unsafe {
  const version: cstring = native.version();
  const handle = native.open();
  if (handle == null) return 1;
  native.close(handle);
}

const observed = unsafe {
  const handle = native.open();
  if (handle == null) return -1;
  const value = native.read(handle);
  native.close(handle);
  select value;
};

let event;
native.poll(out event);
const eventType = unsafe {
  select event.type;
};
```

An explicit `cstring` context may reinterpret a native character-pointer
result. Other unsupported pointers become opaque scope-local identities. They
may be compared with `null` and passed only to native parameters with the exact
same pointer spelling. They cannot be dereferenced, indexed, inspected,
returned, stored outside the block, captured by a closure, passed through an
ordinary Z function to conceal their unsafe origin, or used directly in async
functions. Exact matching native calls remain available. The first tier does
not add raw-pointer syntax or infer ownership, mutation, initialization,
cleanup, or threading facts.

Imported C unions are a separate narrow case. A checked `.zd` `out Union*`
contract may initialize ABI-preserving union storage without `unsafe`. A
`discriminant tag { ... }` type contract may additionally map producer-proven
constants to payloadless variants or cleanup-free struct members. Such values
are inspected with `match (in value)`: payload bindings are non-escaping
`view NativeStruct` values, the fallback binds the raw tag, and lowering is one
native switch with no wrapper allocation. Pointer-bearing payload records are
view-only. Their safe scalar/enum fields remain readable while raw pointer
fields are hidden. A `.zd` type-field projection may expose a compatible
`const char *` field as `view cstring` or `view cstring | null`, with provenance
from a declared native `lifetime`. Without a reusable discriminant contract,
Clang's layout still does not prove which union member is active; after
validating the API's tag, `unsafe` may read a supported scalar or enum member.
Imported-union construction and by-value pointer-bearing record use remain
unavailable in this tier.

An unsafe expression must finish with `select value;`. `select` supplies the
local expression result; `return` continues to exit the enclosing function.
Representable scalars and independently owned Z copies may be selected.
Opaque native identities and locally asserted borrowed `cstring` values may
not. Copy borrowed text with `String.from(value)` before selecting it.

Prefer an adjacent `.zd` contract whenever the fact is reusable or should make
the call safe. Use raw native source when the operation cannot be represented
through Z types at all. Pointer-bearing native records passed by value are one
such current boundary: checked and unsafe Z both reject them. The field
projection vocabulary exposes only non-escaping views into existing native
storage; it does not change the record's ABI representation or make the record
constructible.

### Raw native source

Use raw source only when header import plus `.zd` cannot represent the native
operation. A standalone raw expression must declare every Z operand and its
result:

```z
const value = raw c
  using (in input, inout state, out output)
  : i32 {
    *state += *input;
    *output = *state;
    return *output;
  };
```

`in` permits reads, `inout` permits reads and replacement, and `out` must
initialize a mutable binding without relying on its prior value. The compiler
lowers the expression to an isolated helper function, so native `return` cannot
return from the enclosing Z function or bypass its cleanup. Nothing outside
`using` is visible to the native body.

When the whole function is native, its ordinary signature is the boundary:

```z
function add(left: i32, right: i32): i32 = raw c {
  return left + right;
}
```

The supported language tags are `c`, `cpp`, and `objc`. A raw function may
retain an `on thread.main` declaration. The first tier rejects `async`,
`throws`, generics, raw methods, `move` operands, and Z-owned representations.
Boundary types are currently ABI-stable scalars, `cstring`, and imported native
types. An `in` Objective-C reference passes the object pointer itself, including
when the caller borrows a stored reference with `in resource.file` or
`in this.file` in `deinit`. It does not pass a pointer to the ARC storage slot.
Scalar/value borrows and writable capabilities still use the appropriate
storage address. This does not permit projecting through arbitrary Objective-C
properties or relax the restrictions on hidden Z class alias identity.
Owned structs containing these references can be returned through `Option`
and throwing results. For nested ARC-bearing value payloads, both compilers
use separate payload slots instead of a C union, which Clang ARC cannot safely
copy or destroy. This is inline storage, not an additional heap allocation;
multiple alternatives can require more space than a union.

Embedded source cannot reference compiler-owned private symbols. Legitimate
native symbols such as zlib's `Z_OK` remain usable; sharing a vendor prefix does
not by itself make a name compiler-owned. Native compile errors point to the
original `.zs` body.

A project may explicitly configure `target.platform` and
`target.minimumVersion` together in `z.json`. The target is compile-time project
configuration, not a nullable runtime global. Native declarations introduced
after that minimum version or obsoleted by it are unavailable; applicable
deprecations produce warnings. The same minimum version reaches header import,
generated native compilation, and local Swift compilation. If no target is
configured, Z does not invent one for version comparisons. Stage 0 accepts only
the host platform; cross-compilation and runtime availability guards remain
future work.

Native library selection is explicit project configuration:

```json
{
  "target": {
    "name": "native-example",
    "entry": "main.zs",
    "includeDirectories": ["vendor/include"],
    "link": {
      "directories": ["vendor/lib"],
      "libraries": ["sqlite3"],
      "frameworks": ["AppKit"]
    }
  }
}
```

Each validated, deduplicated library name is translated to the host toolchain's
native library argument. `target.includeDirectories` supplies compiler and
language-server header search paths; `target.link.directories` supplies native
library search paths. Relative entries resolve from the directory containing
`z.json`, absolute entries remain absolute, and configured paths must be
existing directories. Raw linker flags are intentionally not part of this
contract. A header import supplies declarations while `target.link.libraries`
supplies link-time implementations.

Apple targets may additionally list framework names in
`target.link.frameworks`; each becomes one checked `-framework <name>` pair.
This native-link contract is independent of `target.swift.frameworks`.

A reusable systems package owns the native requirements needed by its exported
source surface:

```json
{
  "package": { "name": "desktop", "version": "0.1.0" },
  "library": {
    "entry": "src/desktop.zs",
    "native": {
      "includeDirectories": ["include"],
      "link": {
        "directories": ["lib"],
        "libraries": ["desktop_native"],
        "frameworks": ["AppKit"]
      }
    }
  }
}
```

`library.native` uses the same checked vocabulary as a target, but travels with
the library whenever it is consumed. Paths resolve relative to the package's
own `z.json`; transitive include directories, library search directories,
library names, and frameworks are merged and deduplicated with the consuming
target. The first tier is unconditional. Platform-specific package clauses
will follow Z's target/comptime design rather than introducing a separate
manifest-only condition language.

Every manifest target also supplies a portable `target.name` and a `.zs`
`target.entry`. Omitting `target.kind` selects an executable; `static-library`
and `shared-library` entries are export-only graphs using checked `export c`
boundaries. Project-directory `check`, `run`, and `build` select that entry,
while an explicit `.zs` argument is an entry override that retains the
surrounding target configuration.

C imports may be direct and zero-wrapper. Imported non-null Objective-C classes
are nominal types such as `AppKit.NSWindow`; references use ARC and can be stored
in Z aggregates or named in signatures. Objective-C references stored by a Z
class are strong by default: construction retains each field and deterministic
class cleanup releases it. Native APIs with an independent close-time release
policy, such as `NSWindow.releasedWhenClosed`, must disable that policy when Z
is intended to remain the sole owner. Inferred nullable Objective-C
references display as `T | null`, require a null check before member access,
and narrow in the non-null control-flow path without a runtime wrapper. This
spelling is accepted for imported Objective-C reference fields, parameters,
returns, and locals. General Z values use `Option<T>` while representation and
matching are unified. `Option.fromNullable(reference)` explicitly converts the
native nullable form into `Option<T>` for `some`/`none` matching. Objective-C
references and `.zd`-declared C handles use `nil` or `NULL` as the `none` niche
and remain one pointer with no wrapper allocation; general options use the
ordinary tagged enum layout.

Imported readonly Objective-C class properties keep their familiar member
spelling and are direct message sends:

```zs
const app = AppKit.NSApplication.sharedApplication;
```

The fixed-point compiler emits `[NSApplication sharedApplication]`; there is no
Z wrapper call or allocation. Writable class-property assignment remains a
staged surface, while writable instance properties already use ordinary Z
assignment.

An imported Objective-C property or method returning dynamic `id` remains an
Objective-C reference rather than becoming an untyped Z value. Test its runtime
class with `instanceof`; the compiler lowers the check directly to
`isKindOfClass:` and narrows the true branch to the selected imported class.
This adds no wrapper allocation and keeps ordinary member access statically
checked after the guard.

An owner-tied `.zd` child pointer instead lifts to
`Option<view native.Child>`. `Option` still means present or absent; `view`
independently records that the present child is borrowed from its named native
owner. The owner must remain live and cannot move while that optional view is
in use. In contrast, `Option<native.Child>` contains an owned or ordinary value
according to the capabilities of `native.Child` itself.

An imported Objective-C block parameter accepts a contextual Z closure. Escaping
blocks require `move`; the generated ARC adapter keeps the owned closure
environment alive for exactly as long as the native block. When `.zd` marks the
block `thread any`, the adapter also retains and enters the active Z runtime
around invocation and final release; this grants synchronized runtime access,
not main-executor proof. APIs such as
`NSNotificationCenter` return their ordinary native observer token; Z code
keeps that token and explicitly unregisters it according to the API contract.
Weak capture can keep the persistent block from strongly cycling back to its Z
application state. A computed Z `String` converts
contextually to `NSString` for Objective-C arguments and properties using its
explicit byte length. The non-null Z value may satisfy either a non-null or
nullable `NSString` parameter; this does not introduce null into `String`.
Objective-C class and protocol identity follows the imported runtime name, so
the same `NSString` surfaced through independent headers remains one nominal
type. A non-null `NSString` converts to a fresh owned Z copy when the
destination is explicitly `String`; nullable values must be narrowed first.
Null proofs flow through short-circuit `&&`, `||`, and `!` conditions. Console
formatting can inspect a non-null `NSString` directly without creating that
owned copy.

An Objective-C protocol callback may also receive a block. It is written as an
ordinary function type with `in`:

```zs
function decide(
  in webView: WebKit.WKWebView,
  in action: WebKit.WKNavigationAction,
  in decisionHandler: (policy: WebKit.WKNavigationActionPolicy) => void
): void as "webView:decidePolicyForNavigationAction:decisionHandler:" {
  decisionHandler(WebKit.WKNavigationActionPolicyAllow);
}
```

The adapter preserves the native block under ARC. Synchronous invocation uses
the borrowed callable directly; an ordinary managed function-value copy may
retain it beyond the callback.

Imported Foundation `NSData` exposes an explicit Z safety bridge for byte
storage:

```zs
const bytes = Array<u8>(1, 2, 3, 4);
const data = Foundation.NSData.copy(bytes);
```

`copy(bytes: Slice<u8>): Foundation.NSData` accepts a stored `Array<u8>`, fixed
byte array, or existing Slice. It allocates one ARC-managed `NSData` and copies
the exact byte range once. It does not retain or consume the source. Hover and
completion expose that cost. No no-copy ownership transfer is inferred.

Files that belong in the executable itself use the `std/embed` compile-time
API instead:

```zs
import embed from "std/embed";
import Foundation from "Foundation/Foundation.h";

export const INDEX_HTML: embed.StaticBytes =
  embed.bytes("./assets/index.html");

const data = Foundation.NSData.borrow(INDEX_HTML);
```

`embed.bytes` requires a string literal and resolves it relative to the module
containing the declaration. A missing path or a directory is a compile error.
The bytes are emitted directly into the native binary, and the compiler records
the canonical source path in `NativeArtifact.embeddedFiles` for build tooling.

`embed.StaticBytes` is nominal immutable process-lifetime storage. It is
cleanup-free, copyable, thread-shareable, and cannot be constructed from a
runtime `Array` or `Slice`. It supports `.length`, checked indexing, and an
implicit immutable `Slice<u8>` borrow for synchronous calls.

`NSData.borrow(asset)` is a zero-byte-copy bridge that uses the asset's static
lifetime and asks Foundation not to free the storage. It accepts only
`embed.StaticBytes`. Runtime storage must use `NSData.copy(bytes)`, preserving
the distinction between a statically proven lifetime and an ordinary scoped
borrow. A future consuming runtime transfer remains a separate operation. This
compile-time embedding intrinsic is currently implemented by Stage 0; the
fixed-point native frontend reports its existing first-tier module-constant
boundary rather than silently changing the asset contract.

An owned opaque C handle with a complete `.zd` release contract is nameable
through its import namespace:

```zs
import sqlite from "sqlite3.h";

class Database {
  private handle: sqlite.sqlite3;
}
```

`sqlite.sqlite3` is the non-null owned handle and
`sqlite.sqlite3 | null` is its nullable form. The namespace name is a safe Z
spelling for the header's native identity, not a wrapper or a copy of the
pointer ABI. Fields and ordinary value parameters own it, `in` borrows it, and
`move` consumes or transfers it. If stored in an ARC class, the contracted
native deinitializer runs exactly once when the final class reference is
released.

Runtime conventions that cannot be represented as an ordinary imported call
use explicit standard-library adapters. `import objc from "std/objc";` is not
needed for normal classes, methods, properties, constants, nullability, or
blocks.

`objc.pool(() => { ... })` runs one synchronous inline closure inside a lexical
Objective-C autorelease pool. It returns independently owned or cleanup-free
values and preserves typed failures, draining before either leaves. Borrowed
views and Slices cannot escape, and the closure cannot be async. Lowering emits
`@autoreleasepool` directly without allocating a pool object.

`objc.connect(control, move () => { ... })` owns the
native target/action control and Z closure, installs the target plus selector,
and returns an `objc.Connection`. The connection must remain bound while the
callback is desired; its precise scope lifetime and teardown prevent a weak
target from silently disappearing after a helper returns.

The lifetime may be owned by a longer-lived aggregate rather than a local:

```zs
import objc from "std/objc";

class Application {
  actionConnection: objc.Connection on thread.main;
}
```

Qualified standard-module types keep this canonical source spelling across Z
module boundaries. The field is ordinary ARC identity; releasing the
application tears down the connection, clears the native target/action pair,
and releases the Z closure environment.

Zeroing `weak` Objective-C delegate and data-source properties use
`objc.bind`:

```zs
const binding = objc.bind(tableView, {
  dataSource: controller,
  delegate: controller,
});
```

The object literal names real imported writable protocol properties. Each value
must be a stored Z class implementing the property's protocol. The returned
`objc.Binding` retains the native object, generated `NSObject` adapter, and Z
controller, so the native weak property cannot dangle while the token is live.
The current adapter rejects `assign` and `unsafe_unretained` properties:
releasing their adapter would otherwise leave a dangling native pointer because
those storage conventions do not zero themselves.

An imported method may instead accept and retain an `id<Protocol>` directly,
without a weak property or a paired remove call. `objc.adapt` creates the owned,
storable protocol carrier for that shape:

```zs
const controller = new SchemeHandler({});
const adapter = objc.adapt<WebKit.WKURLSchemeHandler>(controller);
configuration.setURLSchemeHandler(adapter, forURLScheme: "zapp");
```

The controller must be a stored Z class implementing the exact imported
protocol. The result has the nominal type
`objc.Adapter<WebKit.WKURLSchemeHandler>` and may be kept in an ARC class field.
Its native representation is the direct `id<WKURLSchemeHandler>` reference:
the generated `NSObject` adapter retains the Z controller, and normal ARC
storage retains the adapter. There is no second wrapper or dispatch layer.
Passing an adapter for a different protocol is a compile error even though both
native values erase to Objective-C object references.

Protocol existential values may widen to an ordinary Objective-C `id`
parameter without allocation or a source-level cast. The reverse direction is
not implicit: narrowing untyped `id` to a specific class still uses
`instanceof`, and a specific protocol requires checked protocol provenance.

This first tier is conservatively `thread.main`-bound for construction, use,
and destruction. It is intended for stored handler properties such as
`WKWebViewConfiguration.setURLSchemeHandler`. Use `objc.bind` for zeroing weak
protocol properties, `objc.register` when add/remove calls define the lifetime,
and `objc.connect` for target/action.

Retained method-based protocol registrations use `objc.register`:

```zs
const registration = objc.register({
  add: contentController.addScriptMessageHandler(handler, "zapp"),
  remove: contentController.removeScriptMessageHandlerForName("zapp"),
});
```

Both fields are checked imported Objective-C method calls on the same stored
receiver. The add method must contain exactly one `id<Protocol>` parameter, and
the supplied stored Z class must implement that imported protocol. Registration
is immediate. `objc.Registration` then owns the receiver, generated adapter,
and Z controller; during cleanup it invokes the remove method exactly once
before releasing the adapter. The token must be bound or stored. In the first
tier, remove arguments must reuse stable add-time names or literals with the
same native ABI type, preventing teardown from evaluating arbitrary source.

Adjacent `.zd` contracts can safely restrict native pointer surfaces without
introducing a raw pointer into Z. `parameter: null` permits only the native null
value for that parameter. A `view cstring | null` result denotes borrowed,
NUL-terminated native text tied to the function's single borrowed pointer
input. It must be checked for null before `String.from` makes an owned copy;
the owner cannot be consumed while the view remains live.

A fixed C `const char *` input inferred as `cstring` is also call-scoped. Z may
pass an owned `String` directly: its existing NUL-terminated byte storage is
projected for that invocation, the native callee receives one `const char *`,
and ownership plus cleanup remain with the Z caller. Persisting that pointer
after the call still requires an explicit native lifetime contract.

Some native operations keep the owner alive while invalidating storage exposed
by earlier views. A `.zd` function fact such as `invalidates statement;` makes
that effect explicit. The call is rejected until every view derived from
`statement` reaches its last use. Copying borrowed text with `String.from`
creates independent owned storage and therefore ends the loan normally. This
is not `inout`: the C ABI may still receive the same `sqlite3 *` value rather
than writable pointer-slot storage.

Runtime-owned storage may instead be named once in the declaration module:

```z
lifetime eventMemory;

export type NativeTextEvent {
  project text: view cstring | null {
    borrowed from eventMemory;
  }
}

export function native_poll(out event: _): _ {
  invalidates eventMemory;
}
```

This `lifetime` is a compile-time `.zd` identity, not a general Z lifetime
parameter or runtime object. The projected field is available only through a
view-only native record. `native_poll` is rejected while the view is live;
`String.from(text)` makes an independent owned copy when persistence is needed.
Clang verifies the record field and compatible `const char *` ABI. The contract
author remains responsible for the behavioral claims that the bytes actually
belong to `eventMemory` and that the listed calls invalidate it.

A declaration parameter may also use `{ fixed NATIVE_CONSTANT; }`. The
parameter remains part of the header-verified native ABI but is omitted from Z
calls; code generation inserts the named header constant. This is intended for
legacy conventions such as SQLite's `SQLITE_TRANSIENT`, where the C type alone
does not express the safe ownership policy. For an explicitly typedef-cast
integer sentinel, Clang canonicalizes the cast type and Z accepts the fact only
when it matches the hidden native parameter; a function-pointer-shaped
sentinel does not become a general safe Z value.

```z
const rowStatus: i32 = sqlite.SQLITE_ROW;
const bytes = sqlite.sqlite3_column_text(statement, 1);
if (bytes == null) return "missing";
const title = String.from(bytes);
```

The first C-macro tier imports active object-like integer-literal and composable
integer-expression macros defined directly by the requested header. Clang's
target integer rules determine their Z type, namespace and selective imports
treat them like other native constants, and generated source preserves the
original macro token. There is no runtime wrapper or textual expansion in Z.
Header-defined top-level `static const` scalar values are imported through the
same typed constant surface. This includes SDK conventions such as AppKit's
`NSModalResponseOK`; the Clang-derived typedef or builtin scalar type is kept,
and generated native source references the symbolic declaration directly.
Explicitly typedef-cast integer sentinels additionally participate in checked
`fixed` facts as described above. Function-like macros, strings, aliases, and
general constant expressions remain outside ordinary Z values.

C++ values use their native construction and destruction rules. Swift
interop uses interfaces generated by the Swift toolchain rather than a
reimplementation of the Swift ABI. Unsafe pointer operations, when added,
remain explicit escape hatches rather than the default interop path.

C++ free functions preserve their namespace hierarchy. A unique leaf name may
also be called through a short module alias; colliding leaf names require their
qualified namespace path. Imported overloads are selected from argument count
and type, with integer literals preferring `i32` and floating literals
preferring `f64`. If no unique best native signature exists, compilation fails
with `Z0803` and lists the remaining candidates.

Imported C++ records and opaque values use that same hierarchy. For example,
`cpp.zcpp.Point` is both a valid type annotation and record constructor path.
`cpp.Point` is available only when `Point` is unique across the imported module;
otherwise completion omits it and the qualified native namespace is required.

An adjacent `.zd` file may constrain an opaque native value's lifecycle:

```z
declare module "library.hpp" {
  export type zcpp.ManagedValue {
    copy;
    deinit;
  }
}
```

This does not define a Z type or repeat C++ layout. It names an existing native
type and records which of `copy`, `move`, and deterministic `deinit` are safe.
Capabilities must agree with Clang. Copyable native values follow ordinary C++
copy construction. A value declaring `move` without `copy` follows Z's
single-owner rules: an owned binding, argument, return, or containing Z struct
is consumed at the Z level and emitted with native C++ move construction.
Borrowing with `in` does not consume it. The moved-from C++ object's destructor
still runs normally, while Z rejects later source use.

Lifecycle and thread safety are separate contracts. A native owner may cross an
explicit thread only when its declaration adds:

```z
thread {
  transfer;
  deinit;
}
```

`transfer` authorizes moving one unique owner to another thread; inner `deinit`
authorizes destruction on that receiving thread. The first executable tier
supports move-only C++ values and owned C handles. `share` is reserved for a
future retained/shared native identity and is not executable yet. Because these
facts are not encoded by ordinary C/C++ ABI types, declaring them is a trusted
FFI assertion.

Public constructors plus static and instance methods on contracted C++ values are
imported from the header without wrapper declarations. Construction and static
calls live on the native type:

```z
const direct = native.zcpp.ManagedValue(20);
const made = native.zcpp.ManagedValue.from(22);
```

`Type(args)` constructs an owning native value. It intentionally omits `new`,
which is reserved for ARC-managed Z classes. A native `const` instance method
borrows its receiver; a non-const method requires addressable `let` storage:

```z
let copied = owner;
copied.value.add(2);       // C++ mutable receiver
const answer = copied.value.value(); // C++ const receiver
```

Calls lower to ordinary C++ construction, static calls, or member calls. Native
overloads use the same exact selection and `Z0803` diagnostics as imported free
functions. Copy/move constructors are ownership mechanics rather than ordinary
constructor overloads. The synchronous move-only tier supports locals, owned
parameters and returns, whole Z value structs, growable `Array<T>` buffers, and
named Z enum payloads. Array growth uses native move construction and reverse
destruction. Named enums borrow their payload under `match (in value)` and move
it into the arm under consuming `match (value)`; their active native payload is
destroyed automatically. These storage shapes also compose with ordinary
Z-managed fields such as `String`.

Compiler-provided `Option<T>` and `Result<T, E>` use the same non-trivial
tagged-union lifetime machinery, including borrowed and consuming matches.
Direct async frame locals, whole Z value structs/enums containing them, and
fallible task results also support move-only native storage through `try await`
and `attempt await`. Unqualified owned async parameters move native values or
whole native-owning Z aggregates into the child frame at `await`/`task`; the
source is unavailable immediately after task creation. ARC class fields, owned
closure environments, ownership-bearing async output, and child-task output remain
later construction paths. Immutable `in` value/native parameters may suspend: direct
await bounds the borrow to its join, while task requires an explicit `async
scope` and keeps the owner immutable and unmovable until each borrowing task is
joined. ARC class parameters omit `in` and use their ordinary retained-reference
behavior. Value/native `inout` parameters may suspend when called through direct
`await`; the caller's mutable storage remains stable and inaccessible until the
join. An explicit async scope also permits one `inout` child task to hold
exclusive access. Consuming that task through await or cancellation releases the
borrow early; otherwise scope exit releases it. Async `Slice<T>` parameters copy
only their pointer/length descriptor and borrow fixed-array or growable
`Array<T>` backing storage under the same direct-await or scoped-task rules.
The owner may contain Z cleanup-bearing or move-only C++ elements; task-frame
cleanup destroys initialized elements in reverse order on success, failure, or
cancellation. A live Slice loan prevents `Array.push` and other owner mutation
that could invalidate its data pointer. ARC-reference rebinding is not
implemented. Non-throwing
direct-awaited `out` parameters may initialize cleanup-free caller storage and
must do so on every successful path; child-task and ownership-bearing output remain
deferred. Mutations made before failure or cancellation are not rolled back.

Swift-generated C++ compatibility values use this same surface. For example,
the current owned-value probe supports `Swift.OwnedCounter.init(40)`,
`counter.getValue()`, and `counter.setValue(42)`. A generated const method is an
`in` receiver borrow; a generated mutating method requires addressable `let`
storage and is presented as `inout this` in editor help. This is direct generated
C++ member interop, not Swift property syntax: property sugar, generics,
protocols, errors, async, and packages remain separate slices.

A generated `swift::String` return converts when its destination is explicitly
Z `String`:

```z
const description: String = Swift.describeOwnedCounter(counter);
```

This creates a fresh owned UTF-8 copy and preserves the native byte length,
including embedded NUL bytes. Omitting `: String` is diagnosed so that the copy
is visible in source. Swift `String` parameters are not yet accepted: Apple’s
current C++ overlay constructs them through a null-terminated input path, which
cannot represent every Z `String` safely.

Named C++ value references reuse Z's existing parameter capabilities. No C++
reference punctuation enters Z source:

```z
native.inspect(value);              // const T&: call-scoped in borrow
native.adjust(inout value, 2);      // T&: explicit mutable borrow
native.consume(value);              // T&&: owned move-only transfer
```

The same mapping applies to receiver-qualified methods. `const &` borrows an
immutable receiver, `&` requires addressable `let` storage, and `&&` consumes a
move-only receiver. Hover and signature help show `in`, `inout`, or `move this`
using Z terminology. C++ references do not prove non-escape behavior; imported
native code remains a trusted boundary and the first tier treats reference
borrows as call-scoped.

Reference returns, builtin scalar references, copyable `T&&`, and overload sets
whose only distinction changes an argument or receiver capability remain
deferred. The last case is diagnosed rather than silently choosing borrow or
consume. Conversions and general templates also remain later tiers.

Native namespaces may also be selected and aliased with ordinary import syntax:

```z
import { zcpp as math, alpha, beta } from "cpp_math.hpp";

const origin = math.Point({ x: 20, y: 22 });
const moved = math.translate(origin, 1, -1);
```

The binding is a compile-time Z namespace for the native C++ namespace; it does
not create a runtime object or wrapper. Selecting the namespace is preferred
when leaf declarations collide across C++ namespaces.
