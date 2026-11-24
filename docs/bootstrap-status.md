# Bootstrap implementation status

Last reviewed: 2026-08-21.

This document answers “what do the Bun/TypeScript Stage-0 compiler and the
fixed-point native compiler implement today?” It is not the language
specification. Accepted source semantics live in
[`language-reference.md`](language-reference.md); design rationale and open
questions live in [`DESIGN.md`](../DESIGN.md).

The tables describe the current tested boundary.

Status meanings:

- **Implemented**: parsed, type-checked, lowered, and regression-tested for the
  stated surface.
- **Partial**: a useful vertical slice runs, with named boundaries below.
- **Planned**: accepted direction or required experiment, not implemented.

## What “self-hosted” means here

There are three separate milestones, not a time limit on Stage 0:

| Milestone | Current position |
| --- | --- |
| The Z compiler can compile its own Z implementation | Achieved for the native compiler graph: consecutive generations must emit byte-identical C |
| Developers can use native `z` for every supported language feature | In progress: the native driver runs real programs, but some features still require Stage 0 |
| The compiler/toolchain no longer contains TypeScript implementation dependencies | Not complete: Stage 0 remains the parity authority, and foreign metadata/Swift preparation still use TypeScript tools |

The packaged `z-foreign-adapter` is currently built from TypeScript with Bun's
standalone compilation. Not needing a separately installed Bun is therefore
different from having eliminated TypeScript and its runtime from the toolchain.
Ordinary generated Z applications do not embed that compiler runtime.

Retiring Stage 0 from active feature development is a parity and release
checkpoint, not something that happens automatically after self-compilation.
The exit criteria are native acceptance **and rejection** parity for the
supported surface, native ownership/lowering coverage for real consumers,
replacement of the remaining implementation dependencies, and reproducible
toolchain distribution. A historical seed can remain archived after that;
maintaining two feature implementations indefinitely is not the goal.

Both emitters protect generated C-family string literals from C11 trigraph
translation, including embedded JavaScript such as `??=`. Differential tests
preserve all nine sequences through ordinary/async strings, templates, and
module constants; Stage 0 also verifies direct NSString literals and test names.
Strict Clang warnings stay enabled; this adds no runtime conversion.

## Core language

| Area | Status | Current boundary |
| --- | --- | --- |
| Bindings, functions, inference | Implemented | Local inference, demand-specialized generic free functions with inferred or explicit type arguments, recursive dependent generic calls, downstream-private concrete arguments across module boundaries, owned generic-parameter forwarding through explicit `move`, owned results, typed `throws`, nested generic value-struct parameters, and canonical cross-module aliases, plus first-tier value-struct object destructuring and fixed/`Array<T>`/`Slice<T>` positional destructuring with explicit view-backed zero-copy rest. Native emission deduplicates equal generic demands by semantic identity. It executes immutable cleanup-free object destructuring and explicit `copy`/`move` of cleanup-bearing Z structs through one source temporary, with recursive String/Array/struct/enum copying, exact-once selected-field transfer, and destruction of unselected fields. It also executes recursively nested fixed arrays, including cleanup-bearing elements, plus fixed-position and rest `Array<T>`/`Slice<T>` patterns through one source borrow and one length proof. Fixed arrays use compile-time length evidence, whole-owner move/return, recursive explicit copy for copyable element graphs, reverse-order element cleanup, and initialized-prefix cleanup when a later `try` fails. Cleanup-bearing element projections require owner-tied `view` bindings, and rest is a non-owning two-word Slice descriptor. Public/API contracts remain explicit. `inline function` and `cold function` place a function in both frontends (C `always_inline`; `cold`, `noinline`, `minsize`), rejecting an inline function that calls itself and either mark on `main`, `export c`, raw, or async functions. `dispatch while` lowers in Stage 0 to one handler per arm chained by tail calls (`musttail`, `preserve_none`), with the ordinary loop kept under `Z_DISPATCH_THREADED` for other C compilers; the native frontend checks the same rules with the same diagnostics and lowers the loop the same way. |
| Module constants | Implemented literal tier | Module-level `const` values participate in namespace and selective imports, private declarations may infer, and exports require explicit types. Cleanup-free `boolean`, numeric, and `String` literals plus explicitly typed literal `cstring` lower to static native storage without runtime module initialization. Module `let`, calls or general constant evaluation, ownership-bearing global storage, target-conditional values, and runtime initialization remain deferred |
| Structs and methods | Implemented | Value layout, mutation, static methods, deterministic cleanup, independently evaluated value-field defaults through `Type()`, `Type({})`, or partial overrides, and value-struct optional presence through `field?: T` stored as `Option<T>` with omitted `none` and contextual direct-payload lifting. The fixed-point compiler also materializes demand-driven concrete generic value structs, including inferred and explicit nested specializations, cross-module identity, recursive automatic and custom cleanup, construction, independently evaluated specialization-specific defaults, fields, spread, destructuring, declared instance methods with immutable, `inout`, or `move this` receivers, receiver-free static methods/factories with call-site owner inference, and independently generic instance methods. Independently generic methods can specialize in their declaring module over downstream-private arguments. Independently generic static methods on non-generic owners are also executable. Demand-driven generic ARC classes reuse canonical specialization identity for synthesized allocation, ordinary instance methods, atomic retain/release, custom cleanup, ownership-bearing fields, and zeroing weak references. Non-generic, nonthrowing class constructors execute their checked bodies in fixed-point output with owned and borrowed parameter capabilities. Two-level static specialization on a generic owner, generic or throwing class constructors, and custom value-struct constructors remain staged; optional class/C-layout fields and class-field defaults remain deferred |
| Struct spread | Implemented in synchronous Stage 0 and fixed-point value-struct tier | One leading same-type named source through `...source`, `copy ...source`, or `move ...source`, with retained-field capability checks, defaults suppressed, exact generic specialization, shared-identity retention, and whole-source move cleanup. Native C emission covers ordinary and concrete generic value structs with cleanup-free plain/copy fields, explicit String copies, and whole-source moves that transfer retained fields, destroy overridden ownership-bearing fields in reverse order, and also support replacing every field. Multiple spreads, rest destructuring, outer custom-`deinit` structs, other explicit-copy kinds, embedded native value storage, and Phase-1 async-frame execution remain future tiers |
| Optional chaining | Implemented in synchronous Stage 0; native frontend partial | `Option<T>` and nullable foreign receivers, single-evaluation nested field/method access, flat `Option` results, void no-op, owned method results, receiver-tied cleanup-bearing field views, named-owner provenance for `view`-returning methods, never-lvalue assignment rejection, and preserved `throws E`; `inout this` and `move this` require explicit matching. Native parsing, semantic evidence, and C emission cover stable `Option<T>` field projections with direct or already-optional cleanup-free values plus stable `Option<String>?.byteAt(index)`. Temporary/nested receivers, cleanup-bearing views, other method calls, nullable foreign receivers, and optional-call effect projection remain Stage-0-authoritative. Phase-1 async frame execution reports an explicit deferred diagnostic rather than emitting incomplete C |
| ARC classes | Implemented | Identity, sharing, constructors, private fields, weak references, direct local-alias evidence for bounded `inout` exclusivity, and direct inline closure-capture participation in that same call loan without runtime checks. A structurally audited zero-argument accessor whose whole body returns one module `Once<T>.get()` exports that cell's canonical identity across source modules; this improves exclusivity without granting local containment. Directly constructed local value structs retain the identity of explicit direct class fields through projection, local rebinding, and direct field replacement, so Zapp-style context storage participates in the same bounded exclusivity check. A second audited summary carries same-typed class parameters through a synchronous, nonthrowing, nongeneric free function whose body contains only blocks, `if` branches, exhaustive statement-form `match`, and agreeing direct value-struct returns, including across source modules. Match payload bindings are accepted unless they shadow a function parameter; shadowing, disagreement, or any unrecognized path withholds the whole summary. Opaque direct fields fail closed as unknown aliases, while spread, nesting, collection storage, general returned aggregates, value-producing match returns, other control flow, and suspension provenance remain staged. Direct field `view` projections additionally require a locally contained identity: synthesized `new` construction and direct aliases qualify, while arbitrary results, `Once` accessors, custom constructors, owned passing, storage, and move capture do not. Captures preserve class binding semantics: owned `const` references retain mutable instance access, immutable `in` borrows do not gain it, and reference reassignment still requires `let`. Fixed-point native emission supports ordinary and demand-driven generic classes with synthesized initialization, plus non-generic nonthrowing custom class constructors, methods, atomic retain/release, custom cleanup, owned fields, canonical cross-module identity, lazily allocated zeroing weak controls, copied weak-handle retention, and throwing `upgrade()`. Broader audited factory/accessor summaries, nested/stored/general returned aggregate aliases, previously stored callable environments, custom generic or throwing constructors, concurrent weak upgrade, and generic class-field defaults remain staged |
| Traits | Implemented static tier | Nominal conformance, generic declarations/specializations, and generic constraints. Fixed-point native lowering executes constrained calls by selecting the concrete specialized method directly, with no vtable or trait-object allocation. Framework-owned generic functions and methods specialize over downstream-private concrete types while preserving cleanup and canonical semantic identity. A generic function or method can forward its proven constraint into an imported generic method; Stage 0 and fixed-point lowering defer that dependent demand until the downstream concrete type is known. Trait-typed values and existential/dynamic dispatch remain deferred |
| Enums and `Option`/`Result` | Implemented | Payloads, nesting, exhaustive statement/expression matches, and tag equality for payload-free Z enums. Both frontends type a bare `Option.none` argument from a named function's or instance method's concrete `Option<T>` parameter, including `in` borrows; a callable value's or static method's parameter does not yet supply that context. Native synchronous direct RHS match assignments support locals and fields, including captured class state, preserving selected-arm ordering, exact-once owned replacement, and old storage on early return or failure. The native compiler also runs a match value inside any expression: it becomes a prelude local of its statement, after temporaries for the operands written before it (a computed operand, or a number, boolean, or plain enum read from storage), so evaluation stays left to right; inside `?:`, `&&`, or `||` the operator becomes the conditional prelude and the match runs in its branch. An async function with such a prelude takes the general frame. Stage 0 keeps the direct-value rule |
| Errors | Implemented | Typed `throws`, `throw`, `try`, and `attempt`, including synchronous and async cleanup-bearing Z, String, ARC, and move-only native error values with live-state-aware propagation and discard |
| Control flow expressions | Implemented synchronous tier | Ternary, `if`, `match`, `while`, and `for...of` produce values through explicit `select`; loop expressions require an exhaustion `else`, retain cleanup and ownership analysis, allow `continue`, and reject valueless `break`; async loop expressions remain |
| Closures | Partial | Borrowed and owned ARC environments, weak captures, stored throwing function values whose `throws E` effect is preserved through aliases, calls, `try`, and `attempt`, and direct inline ARC captures checked against other accesses in the enclosing synchronous call; nested closures automatically forward read and mutation captures through intervening environments while preserving shadowing and per-boundary ownership/thread checks. Preserving alias provenance after storage and addressable move-only resource capabilities such as `TextBuffer` through a borrowed closure remain |
| Strings and console | Implemented | Owned UTF-8 strings, exact byte equality, templates, typed formatting, checked `byteAt`/`copyBytes`, `byteLength`, `isEmpty`, and explicit move-only `std/text` `TextBuffer`. `String.fromBytes(Slice<u8>)` borrows and strictly validates UTF-8, copies into owned text, preserves embedded NUL bytes, and throws `std/text` `Utf8Error` with a valid-prefix `byteOffset`; additional encodings and consuming conversion remain future work. Grapheme-aware `length` remains planned |
| JSON | Implemented lossless DOM plus expanding derived codec tier | Source-backed `std/json` exports recursive owned `JsonValue`, nominal validated `JsonNumber` with private exact text and checked integer/float conversions, positioned `JsonError`, strict UTF-8 JSON parsing including surrogate-pair escapes, and compact lossless number forwarding. Stage 0 and the fixed-point compiler materialize `decode<T>` and inferred `encode` as direct streaming codecs for public non-optional String/boolean/integer fields, `Array<String>`, nested value structs, recursive `Array<Struct>` trees, readonly arrays, and `Option<T>` fields wrapping those supported types. Null maps to none; non-null maps to some; missing keys require explicit defaults. Encoding borrows the graph into one output buffer; decoding preserves exact-width integers, default replacement, required-field errors, recursive unknown-field skipping, duplicate rejection, and cleanup without an intermediate dynamic tree. Nested Options are rejected as ambiguous. Arrays of Options, other collections, floats, and field-name policies remain staged |
| Numeric safety | Implemented | Decimal, hexadecimal, and binary integer literals plus between-digit separators (also in decimal fractions/exponents) retain source tokens and normalize AST values before contextual range checks and portable C emission. Numeric destinations reach ternary arms and shift operands before inference; numeric aliases provide the same literal context without converting typed variables. Native semantic checking also validates literal-only shift trees, including nested shift counts and signed boundaries; more general constant arithmetic folding remains broader in Stage 0. Native runtime shifts preserve every integer width and signed right-shift behavior. Fixed-array lengths accept the same integer spellings; the bootstrap length representation rejects values above 9007199254740991. Checked integer arithmetic, explicit wrapping/saturating operations, and `Target(value)` construction lower exactly representable integer/float pairs directly and check range, fraction, NaN, infinity, and precision-risk pairs. The fixed-point emitter covers every signed/unsigned integral source and destination width with explicit sign and bound guards rather than implementation-dependent cast round trips. `std/math` begins with type-preserving `math.trunc` for deliberate round-toward-zero composition; implicit and silently lossy conversion remain unavailable |
| Transparent type aliases | Implemented foundation | `type Transform = (value: i32) => i32` names existing function, aggregate, collection, nullable, view, and nested types without changing representation or nominal identity; local/exported/selective/namespace use, construction/static lookup, recursive-chain diagnostics, editor support, and native parser/module parity work; generic alias parameters and opaque/newtype identity remain |
| Generators | Implemented synchronous tier plus composable async tier | Explicit `Generator<T>` and `AsyncGenerator<T>` sequences, terminal `Return`, and `throws E` advancement from `std/iteration`; both forms are cold move-only heap frames with typed `yield`/`return`, explicit `try`/`attempt` on fallible advancement, deterministic return/error/early-drop cleanup, editor support, and native-parser parity. Async `.next()` returns a one-shot `Task` that resumes the persistent stream frame through `if`, `while`, `break`/`continue`, built-in collection `for...of`, borrowed statement `match`, and ordinary awaits; caller cancellation joins the active advancement before cleanup and overlapping advancement is rejected. Async iteration sugar, consuming/value-producing suspending matches, generator methods, borrowed inputs/yields, and sent values remain |
| `comptime` | Planned experiment | No compile-time execution model committed |
| Float bit representations | Implemented | Intrinsic `f32.toBits()` / `f64.toBits()` and `f32.fromBits(u32)` / `f64.fromBits(u64)` preserve exact IEEE 754 representations through alias-safe fixed-size copies, without numeric conversion, allocation, or ownership transfer. Literal arguments receive the matching unsigned context; typed width mismatches are rejected. Synchronous and async-frame execution, native lowering, hover, and completion are covered. General object/pointer bit casting, serialization/endian conversion, and other bit utilities remain separate work |
| Signed integer bit representations | Implemented | `toBits()` on `i8`/`i16`/`i32`/`i64`/`isize` returns the corresponding unsigned representation; the signed type's `fromBits` accepts that exact unsigned type. All patterns are valid two's-complement representations. Both compiler paths preserve checked numeric construction while supporting aliases, primitive views, matching, and async frames. Hover and completion describe representation transfer. Unsigned identity methods, general bit casting, and byte-order conversion are not part of this API |
| Inline assembly | Planned design | Explicit `unsafe` boundary with `in` / `inout` / `out` operands; statement-first lowering, machine constraints, clobbers, target pruning, and backend portability remain to be designed and tested |

## Ownership and collections

| Area | Status | Current boundary |
| --- | --- | --- |
| Moves and deterministic `deinit` | Implemented | Flow-sensitive cleanup across return, throw, loops, and matches |
| Explicit `copy` / `move` expressions | Implemented foundation | Readable contextual prefix keywords; `copy` supports cleanup-free values, owned String, recursively copyable Z structs/enums/arrays, and `.zd`-proven native copies, while `move` transfers unique whole-binding owners and diagnoses later source use; custom copy hooks and direct container-element extraction remain separate design work |
| `in` / `inout` / `out` | Implemented synchronous projected-field tier | Explicit declaration and call-site capabilities. Stage 0 and native call contracts accept direct `in`/`inout` paths through fixed-layout value-struct fields, permit disjoint siblings, and reject repeated or parent/child overlap; native C passes field addresses directly. Synchronous Z ARC `out` initializes fresh storage, destroys displaced references, supports repeated writes and forwarding, and revives cleanup after `move` in both emitters, including conditionally evaluated calls and callback-local storage. `out` remains whole-binding, while ARC fields and mutable method receivers, dynamic indexes, and projected Slice conversion remain conservative. A projected `in`/`inout` may cross a suspension, through direct `await` or a `task` inside an explicit `async scope`, when every segment is a stored field of a named value struct, the borrowed storage holds no ARC class or view, and the call stays on the caller's executor; the child's loan covers only that field path, so siblings stay usable, and lasts until that child is joined or cancelled or the scope exits. Both semantic frontends additionally permit a direct field view to coexist with disjoint sibling mutation. A by-value argument of a cleanup-free type takes no call loan in either frontend, for built-in collection methods as for declared functions, so `values.push(values[0])` is accepted; a value that moves, shares ARC identity, or carries a view keeps its loan. Inside a generic body both frontends decide per instance, with the type arguments settled. |
| Unified loan checker | Implemented foundation | Call-, task-, receiver-view-, and Arena-region lifetimes share one root/capability/lifetime representation and conflict matrix; cross-thread loans remain to integrate |
| Fixed arrays | Implemented | Checked indexing and reverse element cleanup |
| `Array<T>` | Implemented | Empty `Array<T>()` and source-ordered populated `Array<T>(...)` construction, growable owned storage, move-aware elements, checked indexing, reverse destruction, O(1) capacity-retaining `pop(): Option<T>` ownership transfer, `clear()` with immediate reverse element cleanup, and consuming zero-copy `freeze(): readonly Array<T>` publication. `withCapacity(usize)` and `reserveCapacity(usize)` reserve minimum total element capacity without changing length; both frontends implement generic aliases and supported async-frame storage while preserving exclusive loans, ARC identity, and Arena provenance. `append(Slice<T>)` copies a run of cleanup-free elements with one capacity check and one block copy in both frontends, including methods, generics, aliases, and async frames; `appendRepeated(T, usize)` stores one cleanup-free value that many times with one capacity check in both frontends, across the same surfaces; its receiver and argument loans use the ordinary call check. `copyWithin(usize, usize, usize)` moves a run of cleanup-free elements within the Array, overlap allowed, after checking the range and its destination against the length (a trap otherwise), with inline copies for sixteen or fewer and one `memmove` beyond, in both frontends, across the same surfaces; it never grows. Native lowering includes inferred `capacity` access and retains ARC class identity when an indexed element becomes an owned local. Popped view-bearing elements keep Arena provenance, and owned popped values survive supported async suspension. Populated construction directly inside suspended async frames remains a later lowering slice |
| `Map<K, V>` | Implemented hashed tier | Explicit `std/collections` import; amortized O(1) open-addressed lookup, owned value-storage transfer, deterministic replacement/removal/delete/clear, consuming zero-copy `freeze(): readonly Map<K, V>`, `Option<view V>` lookup for values tied into the unified loan checker, and retained `Option<V>` lookup for Z-class, Objective-C, and ARC-managed function identity. Function insertion retains, lookup returns an independently retained handler, removal transfers the stored handle, and destructive operations release exactly once. Native construction/destruction for move-only C++ values, borrowed `Map.Entry<K, V>` iteration with whole-entry or `{ key, value }` patterns, mutation exclusion and editor support, built-in scalar/String/enum keys, and readonly nominal `Hashable` keys through `std/hash` are implemented. Frozen Maps retain normal deterministic cleanup and may participate in deeply readonly cross-thread class graphs when their contents are shareable. The fixed-point compiler emits the complete scalar/nominal-key mutation surface and executes function-valued Maps through the ordinary typed callable handle, including transparent callable aliases imported from separate modules and retained callable copies across ordinary method calls; the message-router differential fixture proves repeated installation of one owned capture, lookup invocation, and exact release. Weak values, native keys, and copy-only native values remain |
| `Set<T>` | Implemented hashed tier | Explicit `std/collections` import; amortized O(1) open-addressed membership, owned unique-value transfer, insertion status, deterministic duplicate/removal/delete/clear cleanup, consuming zero-copy `freeze(): readonly Set<T>`, owned `Option<T>` removal, borrowed element iteration with mutation exclusion and editor support, and the same built-in or readonly nominal `Hashable` contract as `Map`. Frozen Sets retain normal deterministic cleanup and may participate in deeply readonly cross-thread class graphs when their contents are shareable. The fixed-point compiler emits scalar/String/enum/custom-element hashing and equality, complete mutation and cleanup, plus same-Arena provenance for named view-bearing `Hashable` elements |
| `Iterator<T>` | Implemented synchronous tier | Explicit `std/iteration` import; generic nominal conformance, `next(inout this): Option<T>`, explicit mutable loans for stored value iterators, unique temporary iterator storage, owned element transfer and cleanup, native-parser parity, and editor support; consuming, mutable-element, move-only foreign-element, and async iterators remain |
| `Slice<T>` | Partial | Call-scoped `values.slice(start, end)` ranges of fixed arrays, Arrays, and Slices passed directly as Slice arguments in both frontends (synchronous functions only), with checked bounds and the ordinary call loan. Non-escaping parameters plus direct-awaited and scope-bounded child-task borrowing from fixed and growable owners, including cleanup-bearing Z and move-only C++ elements. The fixed-point synchronous compiler emits standalone two-word Slice parameter types, checked indexing/length, fixed-array/`Array<T>`-to-Slice call projection, and positional Slice source/rest lowering without allocation or cleanup. Returned/stored and cross-thread Slices remain |
| Unchecked element access | Implemented first tier | `uncheckedAt(usize)` on fixed arrays, Arrays, readonly Arrays, and Slices, and `uncheckedSet(usize, T)` on mutable fixed arrays and Arrays, inside `unsafe` with cleanup-free elements, in both frontends: checked in a debug build, unchecked with `NDEBUG`. The native compiler executes an `unsafe` statement only when its body is `uncheckedSet` calls; other `unsafe` statements still report `Z1000`. It takes an `unsafe` expression's selected value as a binding's initializer, a returned value, and an assignment's value; an assigned value that needs cleanup is bound first, as a nested `unsafe` expression is |
| Owner-tied `view T` | Implemented narrow tier | `const value = view owner.field/index` local projections; direct field/index results and niche-backed `Option<view T>` lookups from synchronous value-struct methods; synchronous module-function `view T` and `Option<view T>` returns projected from immutable `in` value owners; one-owner local value structs; and same-owner `Array<ValueStructWithViews>` containers established by populated construction, a direct first `push`, or agreeing exhaustive `if`/`match` branches. A synchronous borrowed value-struct method or module function may return a named aggregate containing multiple direct view fields from one owner; wrappers may forward that result or an immutable `in` aggregate while preserving provenance. Immutable object destructuring produces independent view bindings whose collective final use closes the shared loan. Both emitters lower the aggregate to an ordinary C struct of borrowed pointers, and native destructuring evaluates the producer once before field projection; no allocation, retain, or runtime provenance tag is added. Mixed owners within one result, nested borrowed fields, ARC-class or mutable/consuming receiver producers, throwing/async producers, mutable destructuring, and further storage are rejected. Multi-source direct, optional, and aggregate returns conservatively loan every possible input; both frontends enforce owner mutation/move exclusion and precise last-use release inside ordinary and value-producing blocks. Both semantic frontends record direct fixed-layout field paths so a live field view permits disjoint sibling mutation while blocking the viewed field and its parents; native flow state keeps view-value ownership separate from last-use loan liveness across branches and loops. Dynamic indexes and ARC paths stay whole-owner conservative. Views remain inferred const and read-only, support ordinary by-value loads when `T` is cleanup-free and copyable—including contextual `match`/`if` arms—plus synchronous `in T` forwarding and proven nonescaping inline capture. Read-only `view Array<T>` indexing/length/iteration and `view String` inspection/comparison/interpolation preserve the pointer representation through both frontends; no mutation through a live element view or class owners |
| `std/memory` ownership utilities | Implemented narrow tier in both frontends | `replace(inout target, replacement)` transfers initialized storage's previous owner out while installing an exactly typed replacement. Named ownership-bearing replacements require explicit `move`; generated C performs one load, one store, and one return without allocation or copying. View-bearing storage remains excluded until provenance can transfer with the complete value. `Arena` provides stable paged region allocation, inferred owner-tied views, one-owner view-bearing value structs, compatible-owner Arrays, Map values, readonly Hashable Set elements, variant-sensitive enum edges, same-Arena `Option<view T>` recursive links, and synchronous returned `readonly struct` graph bundles that close exactly one Arena over their dependent storage; the production parser now closes its completed `Array<ParsedModule>` into a returned `ParsedModuleBatch` root consumed by resolution and emission. Reverse `deinit`/ARC/native RAII cleanup skips borrowed fields and destroys dependent bundle fields before the Arena, shared loans exclude reset/move until an explicit region-closing construction, aliases preserve semantics, and proven inline captures remain nonescaping. Mutable Arrays, Maps, and Sets establish provenance on first insertion; ownerless enum/Option alternatives contribute no edge, one real owner is retained conservatively, and mixed owners are rejected. View-bearing enums and associative values require named value structs; optional view links and Map lookups use nullable pointers with no tag or cleanup; the fixed-point emitter owns the full Map and Set mutation surfaces for supported built-in and readonly nominal `Hashable` identities; regions remain synchronous and single-threaded |
| General returned/stored borrows | Planned beyond closed regions | Direct, optional, and one-owner retained-aggregate immutable receiver/parameter provenance, provenance-preserving aggregate forwarding and object destructuring, same-Arena fixed composites and collections, exhaustive branch joins, variant-sensitive ownerless enums, same-Arena optional recursive links, Arena-owned Map/Set edges and removal, and one-owner synchronous returned graph bundles are implemented; loop-carried provenance, multi-owner fields within one returned aggregate, nested aggregates, class alias safety, nested/multi-edge region bundles, generator/async transfer, and general lifetime relationships remain open |
| ORC cycle collection | Planned | `Weak<T>` works now; arbitrary strong cycles are not collected |

Readonly Array/Map/Set storage remains owned in both semantic frontends,
including through aliases, generic fields, and optional payloads. `readonly`
restricts mutation; it does not permit implicit field extraction or repeated
consumption of an owner. Inspect a field in place or through a supported borrow;
copy the selected value when an independent snapshot is needed.

The native frontend also infers `length: usize` through readonly Array/Map/Set
fields, transparent aliases, and borrowed views, including nested field reads
inside template interpolation and callback bodies. These scalar observations do
not copy, consume, or thaw collection storage.

Explicit `copy` of supported readonly Array storage produces an independent
snapshot with the same readonly type. Native checking rejects mutating methods
on frozen Array/Map/Set storage, including transparent aliases and copied
snapshots; copying does not make move-only element types copyable.

`std/memory.replace` also transfers direct ARC alias identity and local-
containment evidence with each owner. Aggregates containing nested ARC
identities remain excluded alongside view-bearing storage until whole-value
provenance can move through the exchange.

The first desktop probe shows
the core model handling ARC application state plus move-only documents cleanly,
while the value-struct lookup probe now crosses the first non-escaping wall with
an inferred receiver-tied view.

## Modules and tooling

| Area | Status | Current boundary |
| --- | --- | --- |
| Z source modules | Partial | Explicit exports, manifest-scoped `internal` declarations and aggregate members, namespace/selective imports, aliases, cycle diagnostics, canonical native type identity across intermediate modules, and canonical qualified standard-module field types such as `objc.Connection` while expression bindings remain module-mangled. An `internal` declaration requires `package.name`, remains available to ordinary relative imports within that exact canonical manifest identity, and is omitted from external imports, completion, hover, and checked public metadata; the fixed-point resolver receives the same package identity and enforces the same boundary. Local `z.json` packages declare stable `package` metadata, one implicit `library.entry`, optional exact public subpath `exports`, and path `dependencies`; Stage 0, the language server, native resolver, and fixed-point driver walk the transitive graph, verify package identities, carry public identities independently of filenames, reject conflicting resolutions, and fail closed on undeclared package subpaths before native-header import. Versioned invocation-scoped `.zbuild.json` overlays add exact generated modules without editing authored source or manifests. Both compiler drivers additionally check source hashes, original method resolution, same-receiver replacement, adapter imports, and final types for declarative call adaptations; a generated module assigned an existing package may authorize only its synthetic replacement-member access to a same-package `internal` method, while authored and un-packaged calls remain rejected. The fixed-point driver owns its SHA-256 proof, expression-tree transformation, generated-module loading, and second semantic pass. The low-level exact `imports` map remains bootstrap plumbing rather than the recommended authored surface. Registry downloads, version selection, dependency aliases, lockfiles, native package metadata, and source re-export declarations remain future package layers. Stage 0 supports the broader language; the fixed-point native driver resolves and lowers its complete 41-module self-hosting graph plus the demonstrated application subset |
| `std/sync` `Once<T>` | Implemented main-lifecycle and safely shareable ARC tiers | A module-level `const` holds a statically empty one-shot cell for a Z ARC class. `initialize(move value)` publishes one strong root and returns a move-only `OnceLifetime<T>`. Main-bound payloads retain main-thread initialization and cleanup; compiler-proven shareable payloads permit both on any registered thread and allow unique guard transfer. Shareability reuses readonly graphs, safe `Mutex<T>` fields, atomic ARC, and checked `deinit on thread.any`. Synchronized `get(): T` retains identity; `state(): OnceState` reports `empty`, `initialized`, or `closed` without promising a later operation will succeed. Closing the guard releases the root after unlocking; already retained handles survive. Repeated gets and transparent accessors preserve canonical alias identity. Construction errors precede publication; premature get, duplicate initialize, and reinitialization trap. Both compiler paths reject unsafe payloads, copied guards, and worker transfer of main-bound guards. Embedded shared roots support worker-first initialization and shutdown without main-thread hooks only when the whole library is main-independent. No lazy initialization, reset, replacement, value/native payloads, or optional get is implied. |
| `std/sync` `Mutex<T>` | Implemented scoped exclusive shared-identity tier | `const state = Mutex(value)` owns an atomically retained handle to address-stable storage backed by a real OS mutex. `withLock((in value) => ...)` and `withLock((inout value) => ...)` synchronously block the current OS thread, expose a non-escaping read or read/write borrow, and release the mutex on normal return or typed failure. Independently owned results may leave in Stage 0 and native output, including String, Array, ARC, and Option/Result results with typed-error cleanup; `await`, escaping capture, and borrowed/view results are rejected while locked. A native-worker closure may retain the same Mutex when `T` is transferable and safely destructible on the worker; the caller remains valid and final release destroys the cell once. Main-isolated and otherwise unsafe payloads are rejected at the thread boundary. Inline `move` callbacks may consume owned captures exactly once; unused captures are destroyed on early return or failure without a heap-allocated environment. Ordinary reusable closures remain non-consuming. Read/write locks, atomics, condition variables, semaphores, asynchronous/timed/nonblocking acquisition, explicit handle copying, and public guard values remain deferred |
| CLI | Implemented project/package slice | Stage 0 and the fixed-point native `z` accept a source file or a `z.json` project for `check`, `run`, and read-only source `emit`, and build named executable, static-library, or shared-library targets from a project directory. Every build target has `name` and `entry`; omitted `kind` means executable. A library-only source package may omit `target` and use `library.entry` for `z check`, while `z run` and `z build` require an explicit target. Both drivers resolve transitive local path dependencies, exact package exports, package-owned `library.native` include/link requirements, and invocation-scoped generated modules supplied with `--generated file.zbuild.json`. Tests, `--release`, program arguments after `--`, and live run/test I/O remain. Registry installation, lockfiles, platform-conditional package requirements, versioned shared-library policy, Windows import libraries, header-only emission, and the remaining production options are later layers |
| Native tests | Implemented expectation tier | Top-level `test "name" {}` declarations work in ordinary `.zs` modules, share private module scope, remain in native-frontend parser/semantic parity, and are omitted completely from production emission. Both Stage 0 and the fixed-point native `z test <file.zs>` discover synchronous tests through that file's project-owned imports and execute one native runner. Imported `std/test` provides statement-bounded `expect(...).toEqual(...)` and cleanup-preserving `fail(...)`; failures return owned diagnostics with source locations and later tests continue. Numeric expectation literals use their checked comparison type in either operand position, preserve signed/unsigned bounds in failure output, and reject incompatible typed operands before C emission. Filtering, reusable assertion helpers, project-wide discovery outside the selected import graph, and async tests remain |
| Checked program metadata | Implemented in Stage 0 and the fixed-point native compiler | `z metadata <file.zs | project>` emits schema-versioned JSON containing exported symbol signatures and resolved function, method, and explicit `new` constructor calls whose targets are public Z symbols. String, numeric, boolean, and null literals remain explicit evidence; other arguments expose only their checked types. Zapp consumes this compiler-neutral artifact to derive typed service bindings and application construction without source scanning or a hand-maintained schema. Richer documentation metadata and compatibility policy beyond schema 1 remain |
| System standard APIs | Implemented foundation | Default `std/fs` and `std/process` modules; owned UTF-8 and arbitrary-byte reads, canonical paths and current-executable discovery, recursive directory creation, borrowed UTF-8 and exact-byte writes (`fs.writeText`/`fs.writeBytes`, one copy into the file, no allocation beyond the stdio stream)/process argv, same-filesystem atomic replacement, owned arguments, direct no-shell child launch, typed OS failures, and move-only RAII `fs.Lock` values for blocking exclusive interprocess filesystem locks with consuming early `unlock()`. `std/embed` turns literal module-relative files into nominal immutable process-lifetime `embed.StaticBytes`, records canonical embedded-file dependencies, and supports checked indexing, `.length`, immutable Slice borrowing, and a zero-copy `NSData.borrow` bridge. The fixed-point frontend resolves, reads, lowers, and emits those assets as native static byte storage without a runtime copy. Ambient `process.args()` and `process.executablePath()` are executable-target capabilities; library targets fail closed until an explicit host-argument runtime contract exists |
| Native backends | Partial | Readable C, C++20, Objective-C ARC, and Objective-C++ source generation |
| Native Objective-C subclasses | Bounded stateful synchronous execution in both compilers | `class ... extends ImportedClass on thread.main`, checked designated initialization, `override function ... as "selector:"`, `super`, base-reference conversion, and native ARC identity without a Z wrapper. Private inline scalars/plain native values, owned `String`, and strong imported Objective-C reference fields (including nullable slots), a definite initialization prefix, source `deinit`, and automatic reverse field cleanup work. Construction/destruction callbacks forward to the superclass; ready entries enforce shared/exclusive receiver access through cleanup and preserve receiver lifetime. The paired strict-Clang/UBSan fixture covers 403 subclass objects and 803 stored native resources, allocated string replacement, nullable field replacement/clearing with retained snapshots, source destruction, nested and escaped callbacks, independent receivers, and six reentrant-access conflicts at `-O0`/`-O2`. New native callback entries and inline checked `objc.selector(Type.method)` registrations execute with target/signature, main-thread, and Ready checks. Synchronous subclasses also coexist with async code through native ARC task storage. Broader owned resource fields, escaping field views/captures, weak identity, fallible construction, async overrides, and general suspension composition remain separate tiers. See [the design boundary](objc-subclass-design.md). |
| Foreign Interface IR | Implemented foundation | Raw declarations, API-note merge, normalized contracts, source locations, and availability metadata are separate. The real Clang producer frames functions, scalar typedef evidence, nominal enums, typed native constants, and record layouts/fields as a versioned, length-prefixed `ZFDCL` artifact; unrelated unsupported declarations are projected out while exact native spellings remain on functions, so only a contract that actually depends on unsupported boundary evidence fails closed. The standalone native driver discovers an optional adjacent `.zd`; safely representable header declarations and plain value-ABI functions require no empty sidecar, while operations needing semantic facts fail at their use sites. It prefers the packaged producer beside its own executable, falls back to `PATH`, owns the decoder, and rejects malformed streams or unsupported contract use. Project-local `.z-cache/foreign` identities include module/header/contract, include directories, and target settings; adapter SHA-256 metadata covers Clang's preprocessed header view, so unchanged imports skip AST production and transitive changes invalidate. The Z-owned `.zd` parser/normalizer verifies inferred scalar functions; target-width `isize`/`usize`; concrete Objective-C object parameters as exact call-scoped `in` borrows; decimal, symbolic scalar, or nominally enum-backed integer-status contracts; recursively copyable and move-only C records; opaque C-union output storage with supported scalar/enum discriminants; pointer-bearing cleanup-free payload records retained as view-only types; lifetime-bound `const char *` field projections; owned or conservatively borrowed opaque pointer results/outputs; nullable borrowed `view cstring` results; const-checked `in` and mutable `inout`/`out` scalar pointers with ordinary definite initialization; pointer-only null arguments; and fixed producer-proven constants against those declarations. Fixed ABI positions are omitted from the safe signature but retained in an ordered call plan and reinserted for both direct calls and generated status adapters; null-only positions remain visible and accept only literal `null`. Pointer-handle cleanup proves exact `T *`/`T **` and release signatures, preserves direct `in`/`move` ABI calls, cleans status-produced owners on failure, supports null-guard narrowing, and lowers `Option.fromNullable` with one producer evaluation. An exact header-derived borrowed pointer result is a nullable non-escaping view with no cleanup; `borrowed from owner;` additionally records one immutable input handle as provenance so the result can remain `view T` or `Option<view T>` without outliving or moving that owner. Header-proven character pointers similarly remain direct `view cstring` values, preserve nullability, and reuse explicit owner provenance. Owner `invalidates` effects and declared foreign `lifetime` identities reuse that loan graph to reject a direct native call while an outstanding child or text view may be invalidated, without changing the pointer ABI or adding a runtime check. Symbolic facts must name a producer-proven constant with the exact scalar or enum return identity. Enum errors remain source-nameable imported types through native sema, `Result`, matching, and C emission, while explicit integer construction uses their producer-verified underlying type. Ordinary enum parameters and producer-proven constants preserve that same nominal identity through namespace/selective imports, call checking, exported expression evidence, and C emission; contextual integer literals are rejected at enum boundaries. Copyable foreign structs remain source-nameable through nested construction, field access, direct value/pointer calls, and C emission without wrappers. Contracted writable union pointers lower to exact opaque native storage and address-taking; discriminated members lower as borrowed payload views, while by-value union construction fails closed. Those checked callables enter native sema through ordinary module signatures while uncontracted symbols fail closed. Native lowering emits each required header, direct scalar/record/handle/text/union-output calls, and one-call status adapters that construct `Result<void, E>`. Foreign-cache eviction, broader `.zd` facts and declaration records, and richer native hierarchies remain |
| Language server | Partial | Diagnostics, semantic highlighting, contextual selective-import/object-pattern completion, hover, and Z/native definitions; `copy`/`move` incompatibilities diagnose live and keyword hover explains inferred type, capability source, copy cost, and source invalidation. Semantic failures fall back to conservative syntax-derived keyword/type/declaration/binding tokens and local hover instead of blanking the document, while unchanged sources retain their last successful rich semantic graph across a newly broken dependency. The diagnostic remains authoritative and fallback information never becomes compile evidence. The VS Code/Cursor extension also associates `z.json` with the bundled project schema for manifest completion and structural diagnostics. Native hover separates the source-level Z signature from ABI and availability details, uses source-nameable handle types, and resolves the selected Objective-C receiver instead of merging unrelated selectors. Broader incomplete-pattern and within-expression semantic recovery remains |
| Native definitions | Implemented slice | Namespace/selective C symbols, Objective-C members, and generated Swift compatibility declarations jump to their native headers |
| Self-hosting | Partial compiler | Stage 0 remains the trusted Bun/TypeScript seed, foreign-metadata producer, and Swift-target preparer. The fixed-point native compiler owns Z lexing, parsing, module resolution, semantic evidence, ownership-aware lowering, diagnostics, C emission, its 39-module standalone driver, `z.json`, `check`/`emit`/`build`/cached `run`, and adjacent Clang metadata-adapter discovery. Generation one rebuilds generation two to byte-identical C before publication. The in-process parser now closes each completed module Array into an Arena-owned `ParsedModuleBatch`; resolver and emitter borrow that root while the recursive standalone-driver discovery path retains its ordinary single-module owner. Native execution covers ownership-bearing tasks, typed failures, cancellation, `thread.spawn`, main-executor handoff, top-level one-select unsafe value expressions, one heap-owned invocation frame for bounded linear, `if`, `match`, and `while` suspension, readonly nominal `Hashable` Map keys and Set elements through native `Hasher` lowering, transparent aliases, first-class synchronous function values, consuming `move this` value-struct methods with guarded receiver cleanup and sole-owned-field transfer, cleanup-aware immutable object destructuring with explicit copy/move, move-spread transfer with reverse-order cleanup of overridden owned fields, demand-driven concrete generic value structs across modules with recursive layout/cleanup/construction/field/spread/destructuring plus declared instance/static method specialization, inferred static factories, independently generic methods, demand-specialized generic ARC classes with atomic retain/release and owned-field cleanup, and demand-specialized generic free functions with recursive dependent calls, recursively nested fixed-array values/indexing/copy/destructuring/iteration across module calls and returns, including reverse-order cleanup and initialized-prefix cleanup for ownership-bearing element graphs, fixed-position and zero-copy rest `Array<T>`/`Slice<T>` destructuring with owner-tied element/Slice views, synchronous Slice parameters and fixed-array/Array-to-Slice call projection, zero-copy collection `freeze()` publication, and synchronous `on thread.any` free functions/contextual closures with atomic captured environments. Direct functions use static callable handles; capturing expression closures own refcounted environments; typed throwing calls retain `Result`; and function-valued Maps, including frozen readonly Maps, retain, retrieve, transfer, and destroy the same handles. The `while` tier preserves `break`, `continue`, `return`, `throw`, direct synchronous `try`, per-iteration cleanup, and cancellation without per-iteration allocation. Native rejection parity covers off-main access through worker captures and lexical match loans held across suspension while preserving inherited main-executor proof, ordinary async parameter borrows, consuming matches, persistent async-generator frames, weaker local callable assignment, and non-shareable arbitrary-thread closure captures. A graph-aware source-mapped lowerability preflight reports `Z0700` for ordinary async and non-tail calls to suspending main-executor functions, plus `Z1000` for custom constructors on generic aggregates, two-level static specialization on generic owners, traits, unsupported collection iteration, unsupported fixed-point collection representations, unsupported explicit-copy graphs, optional field views, recursively owned value capture in expression- or block-bodied `thread.spawn`, unsupported native template-part types, object-rest destructuring, value-producing loops, multi-statement unsafe expressions, a `match` value in a `while` condition, in a closure's expression body, or inside the value of another value-producing match's arm, and other syntactically or semantically settled body gaps before raw IR errors can leak; uncatalogued lowering and C-emission failures are labeled as internal compiler errors. General nested suspension, suspending `for`, `try await` inside the placed loop, dynamic delays, cross-executor loans, weak/native collection elements, suspending or method-based arbitrary-thread callables, remaining explicit-copy types, consuming lock-callback captures, worker-context destruction, complete native formatting, the remaining production command surface, migration of remaining expected lowering gaps from the internal-error fallback into coded boundaries, and replacement of the trusted metadata/Swift preparation tools remain staged. See the async/concurrency rows below for the detailed boundary. |

Native subclass continuation (2026-09-10): checked class-entry plans now retain
source/native/superclass identities, exact constructor/override ABIs, main affinity,
inherited initializer restrictions, and explicit typed superclass dispatch sites.
An independently tested native interface emitter passes strict Clang for native
records/enums, selector aliases, borrowed object arguments, and multiple classes.
Dedicated body lowering and implementation emission now execute the restricted
tier. A real native fixture verifies dispatch and exact cleanup, and a freshly
bootstrapped standalone driver emits the same working program. Detached subclass
ASTs without checked plans cannot fall back to the ordinary Z ARC aggregate emitter.
The approved lifecycle gate is now executable in both emitters: constructing and
destroying receivers forward to the superclass, and ready receivers enter Z
overrides. An inner constructor scope keeps native ARC local cleanup before
activation. The paired `-O0`/`-O2` fixture verifies initialization, cleanup,
teardown, and ordinary ready dispatch. Ready entries additionally enforce shared
`in this` versus exclusive `inout this` across native reentry, retaining access
through local destruction and holding native receiver lifetime through guard
cleanup. Five conflict paths and the final-outside-owner release path pass in
both compilers at `-O0`/`-O2`. This costs an inline pointer-sized access counter,
a stack guard, checks, and a scoped native ARC retain/release, not another heap
object. Private inline scalar/plain-native fields, owned `String`, strong
imported native references, weak Z-class handles (`Weak<T>` or `Option<Weak<T>>`),
and source `deinit` now execute with the same gate. Native weak targets and
arbitrary managed aggregates remain rejected. Synchronous Z-only instance methods
use ordinary managed parameter/result types without Objective-C selectors and
obey normal public, package-internal, and private visibility. External callers
can install weak observer handles without inventing a native ABI.
Direct nested calls reuse the active receiver loan; calls through another
binding acquire their own guard. Constructor/deinit work stays inline and
`super` dispatch stays in explicit native entries in this tier.
New synchronous `function ... as "selector:"` entries also execute with checked
source-declared scalar/enum/borrowed-object ABIs. They trap outside Ready instead
of sending to a nonexistent superclass entry, and keep the main/access guards.
Both compilers validate `.zd` `callback selector { target target; type (...) =>
void on thread.main; invoked repeatedly; }` and pair inline
`objc.selector(Type.method)` references with a non-null target of the declaring
native subclass. Method visibility, concrete signature/capability identity,
main-executor context, and known constructing/dying aliases are checked.
Registration also checks Ready before exposing the target to native retention;
the selector itself emits `@selector(...)`, with no closure environment.
Bare/stored selectors remain rejected at this boundary. Explicit invalidation
still owns shutdown and cycle breaking; the display-link probe below exercises
that path. Escaping field loans/captures remain separate work.

Checked superclass delegation (2026-09-11) now releases only the current
entry's receiver access around a synchronous full-expression `super` call with
by-value scalar/enum/plain-record arguments and results, or native object
arguments. Native objects, including borrowed nullable senders and field-value
references, are materialized as precise-lifetime strong ARC snapshots before
release. The receiver stays alive, other active readers remain protected, and
access is restored before argument destruction, Z continuation, or local cleanup.
Nested call expressions, blocks, and writable storage remain outside the tier.
The real AppKit mutable zoom probe now uses `super.zoom(sender)`. Synchronous
native subclasses can now coexist with async programs, including owned native
references across supported main-isolated suspension points. This is no new syntax or blanket
reentry permission; see [the exact boundary](objc-subclass-design.md#checked-synchronous-superclass-delegation).

The async composition checkpoint preserves native ARC identity instead of
selecting Z class retain/release helpers. Native heap-frame cleanup clears
Objective-C locals and owned parameters on completion/cancellation, including
strong fields inside value structs. Cross-thread native subclass captures and
async overrides remain rejected. Main-isolated helpers mixing timers with
arbitrary child awaits, main-isolated `scheduler.yield`, direct timer awaits in a native
`main` declared `on thread.main`, and named-task creation outside the general
native frame remain separate native async composition work; this is not general
async parity. A plain `async function main()` with direct timer awaits,
named-function task spawns, or a named `async scope` runs as a general native
frame on a root executor. In a general frame `await scope.close()` and
`await scope.cancel()` suspend on the scope's join: the await itself closes
admission and forwards cancellation, and the executor runs the remaining
operations. A block-bodied async closure runs as a frame function of its own,
so it may suspend repeatedly, keep locals, and join a worker. An operation
passed to `TaskScope.schedule` runs at most once, and its frame owns the
closure's captures. Any other block-bodied async closure is a reusable value:
its captures stay in the closure's environment and each call lends them to its
frame, so an assignment to a captured `let` is seen by the next call, while the
closure's own parameters belong to the call. An expression-bodied async closure
may lend a capture to the call it awaits the same way. Such a closure may
throw: its caller receives the typed error as the closure's result. A closure
written in a method of a non-generic aggregate lifts the same way. A
block-bodied async closure that borrows its environment (captures without
`move`) or places work on an executor is not lowered natively yet, and no
closure may capture `this` in either compiler.

The related-family close checkpoint (2026-09-13) extends native linear main-task
timer frames to `match`-initialized owned locals and direct `TaskScope.close()` /
`cancel()` joins between timers. A failed initializer, `try`, or early return
finishes the task with the ordinary ownership-planned cleanup; it cannot return
a value from a `void` poll or accidentally continue to the next timer. Cancellation
cleans only initialized frame owners. A worker block awaiting such a function
hops to the main executor, so early completion needs no forwarding there; the
worker shapes that do not hop yet (expression-bodied async workers, workers
capturing a `TaskScope`, async methods) still reject it before C emission.
Stage 0 additionally prepares closures in consuming match subjects,
recovers explicitly borrowed class-field types, and transfers an inline
`attempt await` Result into a known owned synchronous parameter exactly once.

The real [display-link resize probe](../examples/interop/objc/smooth-window/README.md)
now builds in both compilers. It also closed two cross-header composition gaps:
an inferred forward-declared Objective-C return can use the complete class from
another imported header, and native selector matching uses canonical class
identity rather than import-local symbol slots. Nullability, receiver identity,
and callback capabilities stay checked. Full definitions retain their own
contracts; this is not a merge of conflicting header contracts.
Both emitters pass the seven-case bounded AppKit geometry/cleanup matrix at
`-O0`/`-O2`, including interrupted zoom/restore and Reduce Motion. A separate real
WebView check exercises page readiness, intermediate viewport layouts, and clean
shutdown through `NSApplication.run`. The demo's earlier Foundation-only run-loop
pump was insufficient for interactive AppKit dispatch and has been replaced.
Native `objc.register` now applies contextual `String` to `NSString` conversion
to stored arguments; that conversion copies rather than consuming the Z string.
Visual feedback and Zapp integration remain next; these tests do not establish
presentation FPS.

Erased Objective-C identity is source-nameable as `objc.Object` from `std/objc`
in both frontends. The non-null and `| null` forms share the importer's native
`id` identity, with null guards, `instanceof` narrowing, aliases across module
boundaries, native ARC storage, and editor completion/hover/tokens. No wrapper,
new keyword, constructible class, or cross-thread permission is introduced.
Inherited nullable sender overrides now have an accurate annotation. The checked
full-expression delegation above retains each object argument before releasing
the entry guard; erasure by itself grants no reentry permission.
The separate native C free-function `id` import path still needs preserved
nullability evidence; this checkpoint validates Objective-C method metadata,
not guessed pointer qualifiers from a bare C type spelling.

The fixed-point async boundary has narrowed since the compact self-hosting row
was written: a direct call to an imported async free function with a
cleanup-free signature now uses a heap-owned task adapter. It may complete
immediately or begin with one direct `await scheduler.yield()`; the latter
stores its arguments, requeues once, observes cancellation, resumes a
synchronous tail, and transfers its result exactly once under strict C
compilation. `Z0700` remains for broader suspending bodies. One direct awaited
non-consuming ARC class method uses the bounded one-yield frame while retaining
its receiver and transferring either a cleanup-bearing result or a typed error
exactly once. A directly called async adapter with one tail
`return await handler(...)` now owns a heap parent frame: cleanup-bearing value
parameters and borrowed inputs remain valid while its dynamic child runs, child
completion wakes the parent, cancellation propagates to the child, and an owned
result transfers or is destroyed exactly once. General suspending bodies with
locals/control flow around a child await, and named async-function value
conversion remain deferred. The same single-tail-await body is executable on a
non-consuming ARC class method, whose parent frame retains the receiver until
child completion or cancellation. Straight-line method locals before that
await are frame-owned too, including cleanup-bearing values lent to the child.
An ordinary async ARC-class method may now make its single tail operation an
explicit `return await on thread.main this.method()` call. The placement proof
lowers to the existing nonblocking main-method invocation frame; cancellation
propagates through the parent and destroys a suspended child's live owned
locals exactly once. The same single-tail shape now taskifies a placed async
free function with a linear delay-suspending body. Its arguments and live
locals are stored in a separate heap child frame, and parent cancellation
removes the child's timer before running ownership cleanup exactly once.
The placed free-function child may now feed one top-level awaited local in the
ordinary async parent. A cleanup-bearing result transfers into frame storage,
the synchronous suffix resumes after child completion, and both moved
arguments and the owned result are destroyed exactly once on success or
cancellation. The same local may be introduced by
`try await on thread.main operation(...)`: the child transfers its full typed
`Result`, success resumes the suffix, failure moves the owned error into the
parent result and skips that suffix, and cancellation continues to unwind as a
separate structural outcome.
A synchronous typed `try` may also appear in the frame prefix before the final
dynamic await. Failure completes the parent task immediately, transfers the
typed error, and destroys every live cleanup-bearing prefix local exactly once;
success extracts the value and continues toward the suspension point. This
lets framework code validate and publish process-wide state before attaching
to a long-lived native event loop without flattening the validation error.
Non-suspending prefix loops and early-return branches are executable in that
frame as well. A final consuming enum/`Option` match may now move one selected
owned async handler into the frame, suspend only that arm, and complete the
other arms immediately. Handler cleanup is guarded across completion,
cancellation, and unfinished-frame destruction. Synchronous and asynchronous
callable types also carry distinct native identities even when their parameter
and return shapes are otherwise identical. The same prefixed/matched tail shape
now works for free functions as well as class methods. A direct async free
function may also store one awaited method result in frame-owned local storage,
resume through the child's waiter, and execute a synchronous suffix that
inspects or consumes that result. Cancellation and unfinished-frame destruction
release the child, receiver, parameters, and every live local exactly once.
A contextually typed generic `async move (...) => await service.invoke(...)`
adapter now stores its captured ARC service in the callable environment, retains
that environment for each invocation, borrows frame-owned arguments through the
child join, and propagates cancellation through the awaited method. The next
linear tier now gives an ordinary free function two sequential awaited-local
suspension sites in one heap-owned frame. Parameters and locals remain
address-stable across both children, each completion wakes the same parent,
cancellation routes to whichever child is active, and owned results clean up
exactly once. The second child may be an explicit
`await on thread.main publish(value)` direct function call, so service work and
UI publication no longer require isolating the whole handler. The pressure
fixture also proves that an `in` value parameter lent to the first async method
is addressed from parent-frame storage rather than a transient poll-stack
alias. Arbitrary counts, branching between suspensions, and the equivalent
general method-body frame remain staged. Imported `TaskScope` and
`TaskControl` aliases retain their canonical intrinsic identity across linked
modules, and copying either managed handle from aggregate storage uses its
runtime retain operation. An owned `TaskScope` declared in an async frame stays
live through a direct `return await` child and joins during frame finalization
rather than being released before that child starts. Captured ARC identities
submitted through `TaskScope.schedule` receive exactly one capture-storage
retain even when their use inside the operation independently requires a copy.

`ZFDCL` version 13 additionally transports Clang's flag-enum classification,
ABI-erased Objective-C lightweight generic object identities, and recursive
block-function signatures, so native
bitwise expressions retain their nominal imported type without an explicit
annotation and declarations such as `NSDictionary<Key, Value> *` remain the
ordinary nominal `NSDictionary` pointer at the Z boundary. Imported completion
handlers retain their parameter and result identities through fixed-point
normalization. Normalized C
records also retain their exact canonical
Clang identity: aliases such as `NSRect` and `CGRect` are equivalent within one
producer contract while unrelated same-layout structs remain nominally
distinct. Version 10 transports first-tier Objective-C interfaces,
protocols, methods, properties, `id<Protocol>` qualifiers, property ownership,
getter/setter identity, executor affinity, availability, async projection
indices, and semantic type identity/nullability
into the owned native decoder. Native normalization attaches those declarations
as ordinary class/trait/method contracts and owns `objc.register` protocol and
teardown diagnostics. Direct imported instance and class methods now retain
their selected selector and exact ABI evidence through native lowering, emit
ordinary Objective-C message sends, store returned object references under
ARC, and make the standalone driver select `.m` plus `-fobjc-arc`
automatically. Representable instance-property reads use the same inherited
member lookup and executor checks, preserve custom getters, and emit direct
getter messages. Dynamic `id` properties retain their one-pointer Objective-C
representation; `instanceof` lowers to `isKindOfClass:` and narrows the true
branch to a concrete imported class. `objc.register` now carries the selected protocol methods and
exact add/remove argument plan through native lowering, synthesizes an owned
Objective-C protocol adapter plus per-site ARC guard, and clears guard-bearing
Objective-C fields during Z-class finalization. A fixed-point release fixture
proves add/callback/remove order after storing the guard in a Z ARC root.
Inherited selectors retain the dynamic class receiver and `instancetype`
methods rebind their result to that receiver type, while
namespace-qualified enum fields in imported C records retain their nominal
identity through native lowering. Zapp's visible WebKit route now owns its
protocol handler and registration guard in Z, narrows WebKit's dynamic `id`
message body with `instanceof`, and copies the resulting `NSString` into an
owned Z `String` before typed routing. The remaining host seam owns AppKit
process/run-loop orchestration and deterministic smoke-test callbacks; Z now
constructs and strongly owns the content controller, WebView configuration,
WebView, window, registration owner, and registration guard. The transitional
Objective-C host keeps only weak access to those UI identities. The
Foreign Interface IR row above describes the fully consumed C contract tier;
Objective-C writable class properties, optional property access,
broad/header-only native-driver discovery, Objective-C protocol runtime checks,
general Z-class runtime checks, and Objective-C++ selection remain staged.

The fixed-point callable tier also composes through aggregate ownership:
classes and structs may own supported Array, Map, and Set fields without C
declaration-order sensitivity, and synchronous throwing methods lower through
the same `Result<T, E>` ABI as ordinary throwing functions. The maintained
message router proves this with an ARC `Router` owning
`Map<String, Handler>`. The bounded direct-awaited ARC async-method tier now
also carries typed `throws` results through the same `Result<T, E>` ABI. The
native compiler awaits a class method declared with `inout this` (the receiver
is the object's address in either borrow mode), and a method that awaits other
methods on `this` keeps a blocking entry whose awaits have their own helper;
broader suspending method bodies remain staged. Imported transparent callable
aliases also retain the source
signature required for contextual closure lowering while sharing the declaring
module's canonical callable ABI. The router's companion C-callback entry proves
that a checked escaping native callback can own that reusable class graph and
release it deterministically.

Validated generated call adapters now link back to entry-defined exported types
without introducing source import cycles. Ordinary imports in generated files
remain cycle-checked and visibility-checked. Both drivers preserve generated
roots and their ordinary dependencies in emission and cache invalidation; native
lowering supplies checked nominal ABI/cleanup evidence when an adapter returns
its own ARC implementation into a generic replacement. Distinct generic method
instances keep independent semantic sites in Stage 0. The same reduced matrix
executes through both drivers, including owned cleanup under UBSan, and Zapp's
complete native Application.run gate passes with its service beside main. See
[the generated-link contract](generated-adapter-linking.md).

## Foreign interfaces

The callback ownership checkpoint now proves known synchronous Z helpers before
passing them a capturing inline borrowed closure. Both checkers preserve direct
invocation and named helper forwarding, including module aliases, while rejecting
unproven storage/return/capture at the call site with `Z0212`. The proof is not
part of structural callable identity. Owned `move` callbacks and received
Objective-C blocks with ARC-backed environments remain retainable; native inline
callables use call-scoped temporary storage with normal/error cleanup. Recursive,
dynamic, raw, and deferred forwarding remain conservative. Native subclass
execution is still gated independently of this fix.

| Boundary | Status | Current boundary |
| --- | --- | --- |
| Z-to-C exports | Implemented checked value-ABI artifact and embedding-runtime slice in Stage 0 and the native compiler | `export c function` distinguishes a deliberate global C ABI symbol from an ordinary Z module export while remaining importable and callable from Z. The implemented tier emits a private implementation, exact public wrapper, and C/C++-compatible header for scalars, owned UTF-8 `String` inputs projected from validated non-null `const char *`, nested by-value `c struct` values, and fixed-representation payload-free `c enum` values; validates text and enum inputs at the C boundary; rejects unsupported ownership, types, and effects in Z; and checks duplicate symbols across the linked module graph. `z build <project-directory> [--release]` uses the manifest's required `name` and `entry`; `static-library` and `shared-library` make `main` optional and publish the same guarded header plus the selected host-native artifact under `build/`. Generated target-scoped initialize/shutdown functions bound calls from host-created threads, count live entries atomically, leave admission open on `BUSY`, and close it on `DRAINING` while an executor-bound root finalizer is queued. Optional `target.runtime.initialize` retains one cleanup-bearing entry-module owner—such as `OnceLifetime<T>`—until generated shutdown; main-bound roots require host main-thread proof and release scheduling. The native compiler preserves the same manifest, root storage, teardown shape, per-export foreign-thread route installation, and executor-bound ARC release routing: release enqueues the extracted finalizer through the installed route and uses the same finalizer inline when no route is active. Native lowering now owns `Mutex<T>` aggregate fields, borrowing and `inout this` aggregate methods, atomic ARC, synchronized `Once<T>`, expression- or block-bodied `withLock` calls with cleanup-free scalar captures, and the first capture-free scalar worker task; `this`/ownership-bearing worker captures and complete async executor orchestration remain application-root gaps. Project `z emit` exposes the complete generated translation unit without writing an artifact. Native semantic evidence preserves the C representation facts, native lowering emits the wrapper/header/lifecycle shape, and handwritten strict-C consumers exercise both linkage modes. `String` results, zero-copy borrowed `cstring` inputs, slices, typed-error projection, owned results, callbacks, async exports, versioned shared-library packaging, header-only emission, and generated `.zd` metadata follow |
| C functions and scalars | Implemented | Clang AST signatures, selective imports, aliases, variadics |
| C records, unions, and enums | Partial | Complete supported struct layouts, nested records, nominal enums, constants, and `.zd`-classified move-only by-value resources. `export type T { move; deinit release; }` keeps the native record ABI while `owned;` and non-escaping `borrowed;` producer facts govern cleanup; canonical Clang identity carries facts across typedef aliases such as raylib `Texture` → `Texture2D`. Imported C unions receive ABI-preserving storage and may be initialized through contracted `out Union*` parameters. A checked `discriminant` contract maps constants to tag-only or cleanup-free struct payload variants; Stage 0 and the native self-hosting frontend both require borrowed matches and lower them to a direct switch with active-member views, while an explicit fallback preserves unknown tags. Pointer-bearing payload structs are retained as view-only records: safe scalar/enum fields remain visible, raw pointer fields are hidden, and `.zd` may project a compatible `const char *` field as `view cstring [| null]` tied to a declared foreign lifetime. `invalidates lifetime;` rejects calls that may replace that native storage while a projected view remains live. Uncontracted scalar/enum union members remain available only through a local `unsafe` proof. Nominal imported enums convert explicitly outward through checked integer construction such as `u32(value)` while implicit and integer-to-enum conversion remain rejected. Other pointer field shapes, general native lifetime relationships, and by-value union construction remain deferred |
| Clang header ingestion | Implemented spill-backed slice | Header ASTs and macro preprocessor output are imported directly from Clang. Ordinary imports keep the fast bounded pipe path; process-buffer or decoded-string overflow retries through a unique spill file, removing the former 64 MiB plain-C ceiling and importing SDL3's 70.8 MB `SDL_render.h` AST unchanged. Z currently materializes the completed JSON document for semantic filtering; incremental parsing remains a future memory optimization for substantially larger headers |
| C macros | Implemented integer slice plus typed fixed sentinels | Active object-like integer-literal and composable integer-expression macros defined by the imported header receive target-correct scalar types, namespace/selective imports, direct native emission, completion, hover, and definitions. An object-like integer sentinel explicitly cast to a header typedef—such as SQLite's `((sqlite3_destructor_type)-1)`—may additionally serve as producer-proven `fixed` contract evidence after Clang canonicalizes its type against the hidden ABI parameter. Function-like, string, and general expression macros remain outside ordinary Z values |
| C pointers and statuses | Partial | Safe opaque handles and record borrows use adjacent `.zd` contracts, including flat basename discovery for qualified includes; standalone `.zd` checking validates the active source against the real header. Fixed `const char *` parameters inferred with `_` expose an intrinsically borrowed `cstring`; owned Z `String` values project their existing NUL-terminated storage for one direct native call without a copy, move, or cleanup loss in Stage 0 and the fixed-point compiler. Owned nullable `T *` results and `T **` outputs receive deterministic cleanup and expose source-nameable namespace types such as `sqlite.sqlite3`; those owners may persist in ARC class fields and close at final release. By-value C resources use the separate record-resource tier above. Anonymous typedef enums import with their cases, expression-valued integer macros compose from other header macros, and `void throws _ { success CONSTANT; }` projects integer or integer-backed enum statuses into allocation-free typed errors while activating owned outputs before propagation. Named `project ...: Slice<u8>` contracts combine native byte-pointer plus `size_t` pairs into one borrowed argument and lower directly back to `.data`/`.length`; `project inout` additionally requires mutable native storage and explicit Z call-site mutation. Enum-member literal parameters plus explicit `cstring`, declaration-only `clong`, and an owner-tied byte-callback connection provide closed, type-checked C variadic overloads, proven against libcurl. `connection throws _` installs a separate context/callback option pair as one operation and returns a move-only `native.Connection` whose lexical loan guarantees callback removal before owner destruction. Null-only parameters safely hide unsupported pointer values; nullable `view cstring` results borrow their single pointer input and copy into owned `String`; fixed native sentinel parameters preserve the verified ABI while disappearing from safe Z calls; nullable declared handles lift into niche-backed `Option`; owned handles with explicit transfer/destruction facts cross `thread.spawn`. Broader C ABI vocabulary, resource lifetime provenance, general element-typed/retained buffer projections, general callback projections, general pointer/view contracts, and internal toolchain notes remain |
| Native callbacks | Partial | C call-only and escaping callbacks use `.zd` with named context, explicit `invoked once`/`invoked repeatedly` cardinality, and exact release contracts; generated Swift/Objective-C static methods may refine ARC-owned block parameters without inventing context/release ABI. The fixed-point compiler now owns the first retained C-callback path: it verifies callback/context/release ABI positions, hides the context machinery from the Z signature, moves an expression-bodied closure into a heap-owned native box, invokes it through the typed C trampoline, and destroys it exactly once through the declared release callback. It also runs the call-scoped context path for a closure written at the call without `move`: the contract's call lifetime is the non-escape proof, so the closure may capture by borrow (an `inout` parameter, a local it assigns), C is lent the address of its function value in the caller's frame, and nothing is boxed, retained, or released; a named function, a stored function value, or a `move` closure in that position, and a function type that an any-thread callback also uses, remain Stage 0 only. Adjacent `.zd` files augment rather than replace ordinary safely inferred header functions. `thread caller` preserves thread-local ownership, while `thread any` emits atomic closure ownership, checks conservative concurrent-shareability, and automatically enters the runtime captured at registration around both callback invocation and native release. Objective-C object inputs supplied by such a block are callback-local ARC references: they may be inspected during the native invocation, while ordinary capture and aggregate-shareability rules prevent escape into unrelated cross-thread state. This bounded entry now covers C trampolines and ARC Objective-C blocks, including Swift-generated block APIs: their callback boxes keep the executor alive, nested entry restores prior TLS state, and synchronized `Once<T>`/`Mutex<T>` access plus executor-routed ARC cleanup remain available without making the foreign thread an executor. Nested `failure N;` or `failure CONSTANT;` contracts allow compatible throwing Z function values: ordinary returns pass through, while thrown payloads are destroyed and narrowed to the declared callback ABI result. `async completion;` requires exact-once delivery, preserves the raw overload, synthesizes an infallible task, and traps duplicate native completion before re-entering completed storage; a never-invoked callback leaves the task pending. A single non-null Objective-C result is retained in the task frame and transferred to its awaiting owner. `async completion(value, error) { return value; throw error; }` projects a nullable Objective-C error into an owned `Task<T, E>`. Cancellation without a native hook waits for completion before frame destruction. A named/imported `TaskScope` owns repeated callback-created main-executor work and joins it without detachment; returned `TaskControl` identities expose admission and per-operation cancellation without duplicating join ownership. The current C callback tier permits one named byte projection per callback, although its length may multiply several native factors; failure constants are checked for integer/enum category, while exact scalar width and range validation remains. Fixed-point direct context-free callbacks, block-bodied first-class closures, `thread any` callback entry, instance projections, weak cross-thread capture, nullable and broader ownership-bearing completion values, native cancellation hooks, callback-payload preservation, and broader callback projections remain |
| Native availability | Implemented host slice | Explicit `z.json` platform/minimum target, introduced/obsoleted errors, deprecation warnings, native source locations, and matching Clang/Swift deployment flags; cross-compilation and runtime guards remain |
| Native header/library search and linkage | Implemented host slice | Validated, deduplicated target include/link requirements resolve from `z.json`; reusable libraries carry the same paths, library names, and Apple frameworks transitively through `library.native`, with every relative path resolved from the owning package manifest. Package-native requirements are currently unconditional; raw linker flags, platform-conditional package clauses, and cross-platform library resolution remain outside the first contract |
| Raw native source | Implemented narrow tier | `raw c` / `raw cpp` / `raw objc` standalone expressions lower through isolated helpers with explicit `using (in ... / inout ... / out ...) : T` contracts; named functions use `= raw <language> { ... }` and their ordinary parameters/result as the boundary. Native `return` cannot escape the helper, `out` participates in definite initialization, dialect selection is automatic, `on thread.main` composes, and Clang diagnostics map to `.zs`. Stage 0 and the fixed-point parser/lowerer preserve named raw bodies verbatim, retain their explicitly imported native headers, and emit the same source-mapped boundary. Raw shape restrictions are validated before generic materialization, ordinary fields named `c`/`cpp`/`objc` remain ordinary Z, and embedded source cannot reference compiler-owned generated symbols; unrelated native names such as zlib's `Z_OK` remain valid. Tier 1 accepts ABI-stable scalars, `cstring`, and imported native types; async/throwing/generic/method bodies, `move`, Z-owned representations, and embedded-language completion remain |
| Inline `unsafe` Z | Implemented narrow tier | Synchronous `unsafe { ... }` keeps Z syntax and types while allowing a compatible native `char *` result to be asserted locally as `cstring`, retaining another unsupported pointer as a scope-confined opaque identity, or asserting the active scalar/enum member of imported C union storage initialized through a checked boundary. The expression form uses `select` and can produce representable scalars or independently owned Z copies. Opaque and locally asserted borrowed values may compare with null or pass through exact matching native pointer spellings, but cannot be inspected, selected, stored outside the block, returned, captured by a closure, laundered through an ordinary Z call, or used in async functions; `String.from` is the explicit owned-copy boundary for asserted `cstring`. Pointer-bearing by-value records remain unavailable even inside `unsafe` and require `raw` in this tier. Inferred capabilities, pointer arithmetic, and a general raw-pointer type remain deliberately absent |
| Objective-C | Partial | ARC classes/fields, methods, instance and readonly class properties/global object constants, imported property ownership (`weak`/`strong`/`copy`/`assign`), method-parameter `id<Protocol>` qualifiers, labels, nullability, niche-backed `Option.fromNullable`, dynamic `id` class narrowing with `instanceof`, owned `String`/`NSString` copies, escaping blocks, persistent observer tokens, lifetime-safe `std/objc` target/action connections, checked Z-class protocol adapters with owned weak-property bindings, deterministic `objc.register` add/remove guards for retained protocol handlers, and lexical `objc.pool` scopes that drain on normal or typed-error exit without a Z wrapper allocation. Fixed-point `ZFDCL` version 15 carries interfaces, protocols, methods, properties, exact ABI spellings plus semantic type/nullability identity, recursive block-function signatures, qualifiers, ownership, getter/setter selectors, availability, async indices, Clang flag-enum classification, and ABI-erased Objective-C lightweight generic object identities into native normalization. The native resolver attaches Objective-C interfaces as class contracts and protocols as trait contracts, resolves inherited/overloaded selectors by argument shape and labels, accepts non-null subclasses where a nullable superclass reference is expected, preserves nominal imported flag enums across bitwise expressions, recognizes exact canonical C-record aliases within one producer contract, projects representable inherited instance properties and readonly class properties through ordinary member lookup, and natively rejects invalid `objc.register` protocol owners and teardown pairs. The fixed-point emitter lowers direct imported class and instance messages, custom property getters and writable instance setters, ARC object-return storage, `instanceof` to `isKindOfClass:`, contextual owned `String` conversion to `NSString`, `String`-to-`const char *` arguments, captured Z closures into exact imported Objective-C completion blocks, received protocol blocks into typed non-escaping `in` callables, complete `objc.register` plans into owned protocol adapters plus ARC guards whose final release sends the verified remove selector once, and synchronous `objc.pool` closures into direct `@autoreleasepool` helpers with lexical borrowed captures and no heap closure environment. Guard-bearing Objective-C fields are cleared before Z ARC class storage is freed, callback boxes release captured environments exactly once, and freshly bootstrapped fixtures prove getter/setter dispatch, class-property getter dispatch, readonly-property rejection, inherited reference assignment, dynamic class narrowing, canonical record aliases, completion-handler nullability, protocol block dispatch, add/callback/remove ordering, plus cleanup-free and typed-error autorelease-pool exits. Foreign reference properties are message metadata rather than recursively embedded Z storage, so stored-view validation stops at that identity instead of traversing an SDK object graph. The standalone driver automatically writes `.m` and enables ARC. Writable class properties, optional property access, protocol/general Z-class runtime checks, broad/header-only native-driver discovery, Objective-C++, and canonical identity across independent producer contracts remain staged |
| C++ | Partial | Hierarchical/selectively aliased namespaces, typed overloads, records, and `.zd`-contracted copyable or move-only RAII values; move-only values work in synchronous locals/calls/returns, Z structs, dynamic arrays, named enums, compiler `Option`/`Result`, direct async locals, owned async parameters, scoped immutable async borrows, direct-awaited and scope-bounded child-task mutable async borrows, whole Z async value aggregates, fallible async results, and explicit native-thread transfer when `.zd` separately guarantees transfer and receiving-thread destruction; named references and receiver qualifiers map to existing Z capabilities with direct native lowering; reference returns, child-task output async borrows, ARC/closure storage, native sharing, capability-changing overloads, and templates remain |
| Swift via Objective-C | Implemented slice | Generated compatibility header, classes/properties/methods, automatic local dylib build/link, declared-target symbol-graph import of Swift `@MainActor` type/method isolation, qualified `.zd` threading contracts for escaping blocks, and exactly-once callback-to-task synthesis with owned nullable `NSError` failures that resumes safely from arbitrary threads before AppKit work returns to `thread.main` |
| Swift value via C++ | Implemented probes | Native static construction, associated-value enum case factories, const/mutable instance methods, struct return/copy/aggregate storage/round-trip/destruction, and exact owned `String` returns without handwritten shim |
| Broader Swift surface | Planned vertical slices | Length-aware `String` inputs, property sugar, generics, protocols, errors, async, packages; Swift 6.2 currently withholds noncopyable values and async functions from its generated C++ interface |

The Objective-C slice also includes owned standalone protocol adaptation in
both frontends: `objc.adapt<P>` verifies a stored Z controller, emits one
generated adapter, and exposes a storable `objc.Adapter<P>` with direct `id<P>`
ABI. Protocol-qualified callback parameters lower as `id<P>`, and fixed-point
method calls reject an adapter for the wrong imported protocol. The first tier
remains conservatively main-executor-bound.

The Stage 0 and fixed-point Objective-C slices preserve protocol-qualified callback
receivers as non-escaping borrowed values and present received native blocks
as typed `in` callables. Stage 0 can copy one of those callables into owned Z
storage and retain its ARC block bridge; the fixed-point backend executes
synchronous invocation and rejects explicit callable copy until that lowering
tier lands. Imported completion-handler parameters accept captured Z closures,
preserve nullable Objective-C callback values, and release the captured
environment exactly once with the native block. `Foundation.NSData.copy(bytes)` accepts stored `Slice<u8>`-compatible
runtime storage and performs one explicit copy into an independently ARC-owned
native object. `Foundation.NSData.borrow(asset)` accepts only process-lifetime
`embed.StaticBytes` and emits a no-copy, no-free native view. A consuming
no-copy transfer from runtime-owned storage remains staged.

Current interop gaps that block a richer desktop application include
broader Objective-C block shapes, inherited/generic protocol edge cases,
runtime availability guards, cross-compilation, and API notes at SDK scale.
General
`T | null`/`Option<T>` representation unification remains language
foundation work; Objective-C reference options now have the first one-pointer
niche-backed specialization and explicit conversion bridge.

The Swift owned-value probe is intentionally honest about the toolchain: current
generated wrappers copy and deterministically destroy Swift values, but delete
C++ move assignment. Z therefore treats this as copyable foreign RAII, not as
native Swift move support. Generated static and instance scalar methods and
generated associated-value enum case factories are now called directly; this
does not yet imply Swift property, string-input, generic, protocol, error,
async, or package support. `swift::String` returns have one
explicit conversion: an annotated Z `String` destination receives a fresh owned
UTF-8 copy, including embedded NUL bytes. Swift `String` inputs remain rejected
until the boundary is length-aware in both directions. A toolchain-boundary
fixture verifies that Swift 6.2 marks `~Copyable` values and Swift `async`
functions unavailable to C++; Z does not bypass that limit through private ABI.

## Async and concurrency

Native synchronous block callables (including non-void results and `throws E`)
support owned invocation-local String, struct, enum payload, and destructured
String storage.
Locals and by-value parameters clean up on normal fallthrough, return, throw,
failed `try`, and scoped loop exits; returned or thrown ownership transfers out.
Each callback carries its own result/error context through direct returns,
value-producing matches, selecting blocks, and nested `try`, independently of
the containing function. Captured environments retain their independent
lifetime. Borrowed captures in synchronous expression and block bodies use stack
environments and address the original storage, including String, Array, cleanup-bearing
value structs, ARC class handles, and `inout` parent parameters. Replacement through
a mutable capture destroys the former value without taking ownership of the binding.
Inline non-owning callbacks stay at their expression use site, including conditions
and loops; their environments add no heap allocation. Owned
`move` expression and block captures address their retained environment fields,
preserving mutable state between invocations. Scope-aware discovery keeps nested callback
parameters separate. Both emitters have exact-cleanup and allocation-balance
regressions; borrowed reads, mutation, nested forwarding, and parent-parameter
probes assert zero allocations. Direct Array-method mutation capture inference and
addressable move-only resource captures remain separate boundaries. Both
emitters evaluate an inline callback or other call-scoped temporary in the right
operand of `||`/`&&` only when that operand runs, and in a `while` condition on
every iteration, with zero allocations for non-owning callbacks.
Asynchronous native block callables remain staged work. Borrowed expression and block environments in async enclosing
functions explicitly reject until suspension-stable environment storage is proven.

Ordinary object destructuring preserves Stage 0's conservative custom-cleanup
boundary in native checking too: a root `deinit` or custom cleanup nested in
inline fields is rejected before transfer, including through aliases and
concrete generic payloads. A named owner of Z-owned storage is destructured
only through an explicit `copy` or `move` (`Z0220`), as in Stage 0. Ordinary owned String/Array/Option fields and ARC
aliases retain their supported behavior; this does not add partial custom-
destructor relocation.

| Area | Status | Current boundary |
| --- | --- | --- |
| Async syntax and typing | Implemented | Functions/methods, `await`, `task`, task scopes, typed errors, direct-call and block `await on thread.main` / `task on thread.main` placement, and executor-local `await scheduler.yield()` |
| Stackless task frames | Partial | Scalars, owned String/TextBuffer, cleanup-bearing fixed arrays, growable arrays, copied Slice descriptors, owned structs/enums/classes, direct move-only C++ locals and parameters, collection elements containing them, consuming owned enum matches, cleanup-free direct-awaited output, fallible native result transfer through `try`/`attempt`/match, String interpolation, and direct-awaited borrowed aggregate temporaries across suspension. Fresh borrowed aggregates receive address-stable parent-frame storage and exact-once cleanup after child teardown. Values declared directly in `async scope` have live-state cleanup after child join across normal exit, `break`/`continue`, return, throw, and cancellation; cleanup-bearing ordinary conditional/loop/match locals remain |
| Executor | Implemented serial/thread-affine tier | Deterministic FIFO per executor: root/main work uses its serial executor and an explicitly async `thread.spawn` closure owns a private executor bound to that OS thread; shared pools and work stealing remain planned |
| Explicit native threads | Implemented thread-affine tier | `thread.spawn` starts one OS thread for a synchronous or explicitly `async` one-shot closure; an async worker owns a private executor, can await scheduler operations and structured children, can `await on thread.main`, and resumes on the same live worker; `move` is required when capturing; plain values copy, unique Array/String/TextBuffer owners and explicitly contracted C/C++ native owners move, deeply readonly classes share through atomic ARC, and main-isolated Z classes cross opaquely with access and release confined to main; `(): T throws E` produces `Task<T, E>` with live-state-aware owned errors plus bound/direct `try` and local `attempt`; await, cooperative cancellation, and implicit scope exit suspend through race-free cross-executor queues before joining; native `share` remains deferred |
| Callable executor contracts | Implemented synchronous tier plus expanding stored-async task tier | Function types and free functions may declare `on thread.any`; function types may also preserve `on thread.main`. Neither contract schedules work by itself. Arbitrary-thread callables use atomic captured environments and require a recursively shareable graph. Main callables require main proof for construction and invocation, propagate lifecycle affinity through aggregate fields and their defaults, accept main-isolated captures, and cannot be weakened to an executor-local type or transferred to a worker. A `thread.any` callable may satisfy local or main storage. Stage 0 and the fixed-point native frontend preserve the same type identity, field affinity, named synchronous conversion, contextual closure proof, callable-field C lowering, and typed `Result<T, E>` propagation. Function types may now begin with `async`; a contextually typed captured async closure is stored without starting work and direct `await handler(in value)` starts and joins a dynamic child frame through a typed start-frame ABI. Stage 0 also executes `task handler(...)` as a hot structured `Task<T, E>` with typed `try`/`attempt`, consuming cancellation, explicit join, lexical implicit join, ARC capture lifetime, and exact child/context destruction. Borrowed task arguments require named address-stable storage within an explicit `async scope`. Native lowering preserves asynchronous function-type identity through aggregate storage and emits the distinct `start(context, executor, ...) -> Z_AsyncInvocation` C layout. Its executable tier covers expression closures: direct await starts a heap-owned frame, retains the captured environment for that invocation, transfers primitive or ownership-bearing results exactly once, destroys any unclaimed result with the frame, and releases the invocation context under strict C compilation. `attempt await` may materialize a fallible child's existing `Result<T, E>` as the infallible stored callable result without nesting or allocating another result. Completed closures finish immediately; a void closure whose body is one direct `await scheduler.yield()` polls and requeues on a local FIFO executor. The first linear `async main` shape is stackless end to end: its heap-owned parent frame stores the callable, one ordinary local, and the child invocation; passes a cleanup-free local by value or an ownership-bearing local through an address-stable `in` borrow; installs itself as the child's waiter; resumes only after child completion; and then reuses the local before deterministic cleanup. Live state makes normal completion and unfinished-frame destruction clean an owned local exactly once. Frame-level cancellation propagates from parent to child, uses the ordinary waiter wake-up, and deterministically unwinds the child invocation and live owners before marking the parent cancelled. The fixed-point emitter additionally executes one public callable-backed `Task<void>` inside an unnamed `async scope`, including an explicit consuming join or cancellation join and one optional borrowed owner. Typed callable task results/errors, implicit scope-exit join, general enclosing-function shapes, multiple children/locals/arguments, and named scopes remain next. Named async-function conversion, suspended stored-closure `try await` propagation, native-placement `attempt` payloads, async methods as values, broader owned captures, and weak captures remain deferred. |
| Structured scopes | Implemented slice | Lexical child joins, sibling/descendant cancellation, shared immutable and exclusive mutable child borrows of whole bindings or disjoint value-struct fields, plus named `async scope updates {}` handles. Both semantic frontends enforce the child-task loans: the explicit-scope requirement, overlap between children, and reads, writes, moves, and replacement of borrowed storage until the child's join, keeping a loan that any continuing path still holds and keeping every loan until the scope join inside a loop. A child site may not cross a loop back-edge while frames use one fixed slot per syntactic site; direct await or an async scope created inside each iteration provides a proven join. Imported `TaskScope` accepts thread-safe callback submissions onto `thread.main`, rejects during close, and joins accepted synchronous `(): void` or explicitly async `async (): void` roots and their descendants. `schedule` returns a cleanup-bearing, non-joining `TaskControl` with `accepted`, `requestCancel()`, and `isCancellationRequested`; scheduled async roots handle errors locally. The fixed-point emitter now executes the explicit `new TaskScope()` form, including contextual operation typing, main placement, an embedded current-thread fallback executor when no Z task encloses construction, and exactly-once transfer of cleanup-bearing closure captures and async parameters through suspension and cancellation. A stored async closure may directly await a linear method that suspends on scheduler-aware `delay`: the child parks in the executor's monotonic timer queue, normal scope close waits for its deadline, and `TaskControl.requestCancel()` removes and resumes it immediately for exactly-once owned-frame cleanup. Branching and looping delay-method frames remain staged. Z Notes uses this path through the standalone native driver rather than forcing Stage 0. |
| Caller cancellation | Implemented slice | Consuming `await task.cancel()` requests cancellation, joins descendants and cleanup, and discards an unclaimed completed outcome |
| Timers | Implemented slice | Scheduler-aware monotonic `delay`; blocking `sleep` remains synchronous |
| Cooperative scheduling | Implemented | `await scheduler.yield()` requeues the current task on its existing executor without a timer or executor hop and exposes a structural cancellation-observation point |
| Sync work in async frames | Partial | Z and supported direct native calls/methods, console, checked arithmetic, `cstring` locals/calls, concise and block-arm matches, synchronous nonescaping inline closures with case-local environments, and receiver-tied views whose last use ends before suspension. A complete Zapp service bridge combines consuming typed results, cleanup-bearing immediate arms, ARC service arguments, selected async children, and synchronous owned-result matches after resumption. Its generated placed-method route decodes and transfers an owned request, retains a typed error through `attempt await on thread.main`, and destroys cleanup-bearing locals introduced in the post-resumption match arm. An ordinary free function can now sequence two top-level awaited local bindings through one heap-owned parent frame with address-stable locals and active-child cancellation; arbitrary suspension counts and branching frame graphs remain staged |
| Embedded awaits | Partial | Left-to-right cleanup-free values, awaited conditions, selected match/if/ternary/logical branches, and nested lazy boolean conditions; arbitrary lazy-expression embedding inside larger calls/aggregates remains |
| Lazy/suspending expressions | Implemented direct-value tier | `&&`, `||`, ternaries, value `if`, and value `match` preserve selected-branch evaluation in async binding, return, and control-condition positions. Selected results transfer scalar, ARC, String, Z-owned, or move-only native values; typed propagation and cancellation retain exact cleanup |
| Executor placement and isolation | Implemented ownership-aware native-aware tier | `thread.main` is typed; hop-and-wait, nested suspension, direct placed calls, and structured children execute through main placement. Block captures use contextual `using (in value, inout state, move owner)`; cleanup-free Copy values and String snapshots may remain inferred, loans last through join, borrowed children require an async scope, and `out` remains deferred. Async direct callees flatten to their original task frame; synchronous nonthrowing calls use a one-shot placed frame. Existing proof comes from declaration contracts or enclosing placement, so the redundant bare synchronous proof block was removed. Z `class`, `struct`, and `function` declarations accept a header `on thread.main` contract, and stored fields accept `field: Type on thread.main`. A selected field makes lifecycle main-bound while unrelated readonly thread-safe fields and unrestricted methods of a mixed ARC class remain usable on workers; unsafe fields are conservatively main-only and unrestricted methods cannot escape bare `this`. Whole-class isolation remains opaque off-main. A stored Z ARC class reference is now treated as a transportable executor-routed handle rather than inline isolated storage: a containing value aggregate may be constructed, returned, and cleaned up off-main, while access to the referenced class still enforces every field and method contract. Direct native and value storage continues to propagate affinity transitively. Explicit Clang actor attributes, declared Swift-target symbol graphs, and `.zd` native type/function/method fallbacks enter the same FIIR affinity fact. Stage 0 and native sema enforce off-main field, method, and function rejection; both also check trait executor requirements contravariantly across module boundaries, allowing a broader implementation but rejecting an implementation that silently requires `thread.main`. Placed bodies and `Mutex.withLock` closures inherit the active proof, and construction plus weak-reference operations consult lifecycle affinity. Hover exposes access, lifecycle placement, and transportable ARC handles. Values/errors return to the original executor and cancellation routes to the child-owning executor; Darwin installs and wakes a CFRunLoop source. Throwing synchronous direct calls, aggregate worker capture containing executor-routed handles, raw foreign-identity transport, async isolated auto-hop, external prebuilt Swift module metadata, Windows message-loop integration, and Linux toolkit adapters remain |
| Channels | Native bounded synchronous tier; Stage 0 async waiters | `Channel<T>.bounded(capacity)` splits shareable `Sender<T>` from one unique `Receiver<T>`. Both compilers execute `.sync()` conversion, blocking send/receive, close/drain, unsent ownership through `ChannelClosed<T>`, sender retention, unique receiver transfer, and deterministic queue cleanup. Native endpoint storage composes with named yielding worker frames, cancellation/join, callable signatures, aliases, and cross-module aggregates. Native asynchronous `Sender.send` / `Receiver.receive` still report `Z0700`; suspending backpressure and cancelled waiter removal execute through Stage 0. Any message type makes a channel in both compilers; one that cannot cross threads is rejected where an endpoint would carry it across, as a `thread.spawn` capture of the endpoint or of a value holding one (`Z0704`). The native transferable-type proof behind that check keeps custom destructor and broader foreign-resource proofs conservative. The measured Stage 0 capacity-one synchronous cross-thread path matches C with fixed allocation; the async producer currently allocates one heap-owned task frame per send. Native synchronous throughput has not yet been benchmarked. Frame reuse is tracked below. Unbounded/rendezvous storage, selection, timeouts, and concurrent receive loans remain future tiers |
| Async frame allocation efficiency | Measured optimization target | Repeated short async operations currently allocate and free one owned task frame per invocation. A 250,000-send channel run requested 250,004 balanced allocations and about 44 MiB, while the synchronous control used four fixed allocations and matched C. A future per-executor frame cache, size-class pool, or equivalent reuse mechanism should make allocation growth proportional to peak in-flight work rather than total completed operations. It must preserve exact live-state cleanup, cancellation, waiter removal, executor-routed destruction, and sanitizer-clean shutdown |
| Actors | Planned direction | Actor API, isolation, mailbox policy, and supervision remain intentionally unsettled; bounded channels are the implemented communication primitive rather than a prematurely fixed actor surface |
| CPU parallelism | Partial evidence | One explicit native thread can execute Copy-value, uniquely owned Array/String/TextBuffer, or deeply readonly shared-ARC work in parallel without blocking unrelated FIFO tasks or timers; its async continuation remains thread-affine across suspension and main-executor hops; pools, general sendability, mutable shared-state isolation, and multithreaded executors remain planned |

See [`async-model.md`](async-model.md) for the intended model and phase details.

## Validation probes

- [`examples/applications/z-notes`](../examples/applications/z-notes): persistent
  AppKit application, ARC-owned note model, optional selection, direct SQLite
  declaration import, owned database/statement cleanup, borrowed native text
  views, explicit `sqlite3` linkage, `std/objc` target/action, and async startup
  loading on a dedicated worker. The worker creates and destroys its SQLite
  owner locally, transfers an owned `Array<Note>` through `Task<T, E>`, and the
  main task enters the synchronous AppKit lifetime through
  `await on thread.main`.
- [`examples/applications/document-workspace`](../examples/applications/document-workspace): cross-platform,
  multi-module document registration and saving with move-only native leases,
  cleanup-bearing errors, optional views, array growth, and zero live resources.
- [`examples/applications/project-index`](../examples/applications/project-index): multi-module Map/Set
  pressure test with borrowed String-key lookups, owned record snapshots, typed
  filesystem errors, and a fixed dense-to-hashed benchmark.
- [`examples/applications/source-stager`](../examples/applications/source-stager): reads a requested Z
  source file, writes a staged copy, observes native argv, and launches Clang
  directly through the first self-hosting standard APIs.
- [`compiler/frontend`](../compiler/frontend): reusable native Z lexer/parser,
  owned flat AST arenas, and the in-process parser-library bridge to stage 0.
- [`examples/applications/source-inspector`](../examples/applications/source-inspector): readable clients and smoke tests for the native frontend, including a
  fallible owned-token generator with a terminal scan summary, a recursive
  shape-stable AST-state probe, and the standalone lexer/parser protocol
  executables.
- [`examples/interop/objc/nswindow.zs`](../examples/interop/objc/nswindow.zs): direct AppKit window.
- [`examples/interop/objc/objc-nullability.zs`](../examples/interop/objc/objc-nullability.zs): explicit
  `T | null` AppKit guard narrowing alongside `Option.fromNullable` and
  `some`/`none` matching.
- [`examples/interop/objc/desktop-ownership`](../examples/interop/objc/desktop-ownership): ARC application
  model plus move-only owned documents and AppKit shell.
- [`examples/interop/objc/desktop-ownership/ownership-views.zs`](../examples/interop/objc/desktop-ownership/ownership-views.zs): zero-copy scoped
  lookup compared with an independently owned document snapshot.
- [`examples/interop/objc/appkit-events.zs`](../examples/interop/objc/appkit-events.zs): persistent native
  notification callbacks, weak Z capture, imported notification constants, and
  explicit observer-token removal.
- [`examples/interop/objc/target-action.zs`](../examples/interop/objc/target-action.zs): explicit
  `std/objc` connection ownership for AppKit's weak target plus selector convention.
- [`examples/interop/swift/swift-interop`](../examples/interop/swift/swift-interop): Swift class through its
  generated Objective-C compatibility header.
- [`examples/interop/swift/swift-task-scope`](../examples/interop/swift/swift-task-scope): Swift global-queue
  callback through an ARC-owned block, atomic Z closure environment, named
  `TaskScope`, generated symbol-graph `@MainActor` isolation, synchronous
  callback completion, bounded runtime entry for synchronized application-root
  lookup, and a joined AppKit operation on `thread.main`.
- [`examples/interop/swift/swift-value-interop`](../examples/interop/swift/swift-value-interop): Swift-native
  owned value constructed and called directly, then stored in a Z aggregate,
  through its generated C++ compatibility header.
- [`examples/interop/swift/swift-enum-interop`](../examples/interop/swift/swift-enum-interop): Swift-native
  associated-value enum cases constructed directly through generated callable
  case factories, then copied and called as owned values.
- [`examples/interop/cpp/foreign-values.zs`](../examples/interop/cpp/foreign-values.zs): `.zd`-contracted
  copyable C++ RAII value copied through an owning Z aggregate with zero live
  native values after scope exit.
- [`examples/interop/cpp/cpp-move-only.zs`](../examples/interop/cpp/cpp-move-only.zs): `.zd`-contracted
  non-copyable C++ RAII value borrowed, moved through an owned function and a Z
  value struct, then deterministically released with zero live native values.
- [`examples/interop/cpp/cpp-move-only-array.zs`](../examples/interop/cpp/cpp-move-only-array.zs): move-only
  native values stored in a growable array, relocated through native move
  construction, and destroyed in reverse order, including a mixed `String`
  aggregate.
- [`examples/interop/cpp/cpp-move-only-enum.zs`](../examples/interop/cpp/cpp-move-only-enum.zs): named
  enum payloads borrowed or consumed through `match`, replaced safely, and
  deterministically destroyed.
- [`examples/interop/cpp/cpp-arena.zs`](../examples/interop/cpp/cpp-arena.zs): move-only C++
  values transferred into stable arena storage and destructed by reset.
- [`examples/interop/cpp/cpp-references.zs`](../examples/interop/cpp/cpp-references.zs): C++ named-value
  references and receiver qualifiers mapped onto existing Z `in`, `inout`, and
  owned-transfer semantics with direct lvalue/`std::move` lowering.
- [`examples/async/async-native-ownership.zs`](../examples/async/async-native-ownership.zs): a move-only
  C++ value constructed directly in aligned task-frame storage, returned and
  relayed through task results, consumed by its caller, and cleaned exactly once.
- [`examples/async/async-collection-slices.zs`](../examples/async/async-collection-slices.zs): growable
  and cleanup-bearing collection owners borrowed as Slices across direct await,
  scoped task, and cancellation, followed by safe growth and reverse cleanup.
- `bun run test`: compiler, runtime, diagnostics, interop, async, self-hosting, and
  editor regression suite. The independently runnable tiers and parallel CI
  architecture are documented in [`testing.md`](testing.md).
