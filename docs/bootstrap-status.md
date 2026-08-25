# Bootstrap implementation status

Last reviewed: 2026-08-21.

This document answers “what do the Bun/TypeScript Stage-0 compiler and the
fixed-point native compiler implement today?” It is not the language
specification. Accepted source semantics live in
[`language-reference.md`](language-reference.md); design rationale and open
questions live in [`DESIGN.md`](../DESIGN.md).

The summary tables describe the current tested boundary. Dated continuation
notes later in this document are chronological engineering evidence; they are
not a second, competing status definition.

Status meanings:

- **Implemented**: parsed, type-checked, lowered, and regression-tested for the
  stated surface.
- **Partial**: a useful vertical slice runs, with named boundaries below.
- **Planned**: accepted direction or required experiment, not implemented.

## Core language

| Area | Status | Current boundary |
| --- | --- | --- |
| Bindings, functions, inference | Implemented | Local inference, demand-specialized generic free functions with inferred or explicit type arguments, recursive dependent generic calls, downstream-private concrete arguments across module boundaries, owned results, typed `throws`, nested generic value-struct parameters, and canonical cross-module aliases, plus first-tier value-struct object destructuring and fixed/`Array<T>`/`Slice<T>` positional destructuring with explicit view-backed zero-copy rest. Native emission deduplicates equal generic demands by semantic identity. It executes immutable cleanup-free object destructuring and explicit `copy`/`move` of cleanup-bearing Z structs through one source temporary, with recursive String/Array/struct/enum copying, exact-once selected-field transfer, and destruction of unselected fields. It also executes recursively nested fixed arrays, including cleanup-bearing elements, plus fixed-position and rest `Array<T>`/`Slice<T>` patterns through one source borrow and one length proof. Fixed arrays use compile-time length evidence, whole-owner move/return, recursive explicit copy for copyable element graphs, reverse-order element cleanup, and initialized-prefix cleanup when a later `try` fails. Cleanup-bearing element projections require owner-tied `view` bindings, and rest is a non-owning two-word Slice descriptor. Public/API contracts remain explicit |
| Module constants | Implemented literal tier | Module-level `const` values participate in namespace and selective imports, private declarations may infer, and exports require explicit types. Cleanup-free `boolean`, numeric, and `String` literals plus explicitly typed literal `cstring` lower to static native storage without runtime module initialization. Module `let`, calls or general constant evaluation, ownership-bearing global storage, target-conditional values, and runtime initialization remain deferred |
| Structs and methods | Implemented | Value layout, mutation, static methods, deterministic cleanup, independently evaluated value-field defaults through `Type()`, `Type({})`, or partial overrides, and value-struct optional presence through `field?: T` stored as `Option<T>` with omitted `none` and contextual direct-payload lifting. The fixed-point compiler also materializes demand-driven concrete generic value structs, including inferred and explicit nested specializations, cross-module identity, recursive automatic and custom cleanup, construction, independently evaluated specialization-specific defaults, fields, spread, destructuring, declared instance methods with immutable, `inout`, or `move this` receivers, receiver-free static methods/factories with call-site owner inference, and independently generic instance methods. Independently generic methods can specialize in their declaring module over downstream-private arguments. Independently generic static methods on non-generic owners are also executable. Demand-driven generic ARC classes reuse canonical specialization identity for synthesized allocation, ordinary instance methods, atomic retain/release, custom cleanup, ownership-bearing fields, and zeroing weak references. Two-level static specialization on a generic owner and custom constructors remain staged; optional class/C-layout fields and class-field defaults remain deferred |
| Struct spread | Implemented in synchronous Stage 0 and fixed-point value-struct tier | One leading same-type named source through `...source`, `copy ...source`, or `move ...source`, with retained-field capability checks, defaults suppressed, exact generic specialization, shared-identity retention, and whole-source move cleanup. Native C emission covers ordinary and concrete generic value structs with cleanup-free plain/copy fields, explicit String copies, and whole-source moves that transfer retained fields, destroy overridden ownership-bearing fields in reverse order, and also support replacing every field. Multiple spreads, rest destructuring, outer custom-`deinit` structs, other explicit-copy kinds, embedded native value storage, and Phase-1 async-frame execution remain future tiers |
| Optional chaining | Implemented in synchronous Stage 0; native frontend partial | `Option<T>` and nullable foreign receivers, single-evaluation nested field/method access, flat `Option` results, void no-op, owned method results, receiver-tied cleanup-bearing field views, named-owner provenance for `view`-returning methods, never-lvalue assignment rejection, and preserved `throws E`; `inout this` and `move this` require explicit matching. Native parsing, semantic evidence, and C emission cover stable `Option<T>` field projections with direct or already-optional cleanup-free values plus stable `Option<String>?.byteAt(index)`. Temporary/nested receivers, cleanup-bearing views, other method calls, nullable foreign receivers, and optional-call effect projection remain Stage-0-authoritative. Phase-1 async frame execution reports an explicit deferred diagnostic rather than emitting incomplete C |
| ARC classes | Implemented | Identity, sharing, constructors, private fields, weak references, direct local-alias evidence for bounded `inout` exclusivity, and direct inline closure-capture participation in that same call loan without runtime checks. A structurally audited zero-argument accessor whose whole body returns one module `Once<T>.get()` exports that cell's canonical identity across source modules; this improves exclusivity without granting local containment. Directly constructed local value structs retain the identity of explicit direct class fields through projection, local rebinding, and direct field replacement, so Zapp-style context storage participates in the same bounded exclusivity check. A second audited summary carries same-typed class parameters through a synchronous, nonthrowing, nongeneric free function whose body contains only blocks, `if` branches, exhaustive statement-form `match`, and agreeing direct value-struct returns, including across source modules. Match payload bindings are accepted unless they shadow a function parameter; shadowing, disagreement, or any unrecognized path withholds the whole summary. Opaque direct fields fail closed as unknown aliases, while spread, nesting, collection storage, general returned aggregates, value-producing match returns, other control flow, and suspension provenance remain staged. Direct field `view` projections additionally require a locally contained identity: synthesized `new` construction and direct aliases qualify, while arbitrary results, `Once` accessors, custom constructors, owned passing, storage, and move capture do not. Captures preserve class binding semantics: owned `const` references retain mutable instance access, immutable `in` borrows do not gain it, and reference reassignment still requires `let`. Fixed-point native emission supports ordinary and demand-driven generic classes with synthesized initialization, methods, atomic retain/release, custom cleanup, owned fields, canonical cross-module identity, lazily allocated zeroing weak controls, copied weak-handle retention, and throwing `upgrade()`. Broader audited factory/accessor summaries, nested/stored/general returned aggregate aliases, previously stored callable environments, custom generic constructors, concurrent weak upgrade, and generic class-field defaults remain staged |
| Traits | Implemented static tier | Nominal conformance, generic declarations/specializations, and generic constraints. Fixed-point native lowering executes constrained calls by selecting the concrete specialized method directly, with no vtable or trait-object allocation. Framework-owned generic functions and methods specialize over downstream-private concrete types while preserving cleanup and canonical semantic identity. Trait-typed values and existential/dynamic dispatch remain deferred |
| Enums and `Option`/`Result` | Implemented | Payloads, nesting, exhaustive statement/expression matches, and tag equality for payload-free Z enums |
| Errors | Implemented | Typed `throws`, `throw`, `try`, and `attempt`, including synchronous and async cleanup-bearing Z, String, ARC, and move-only native error values with live-state-aware propagation and discard |
| Control flow expressions | Implemented synchronous tier | Ternary, `if`, `match`, `while`, and `for...of` produce values through explicit `select`; loop expressions require an exhaustion `else`, retain cleanup and ownership analysis, allow `continue`, and reject valueless `break`; async loop expressions remain |
| Closures | Partial | Borrowed and owned ARC environments, weak captures, stored throwing function values whose `throws E` effect is preserved through aliases, calls, `try`, and `attempt`, and direct inline ARC captures checked against other accesses in the enclosing synchronous call; nested closures automatically forward read and mutation captures through intervening environments while preserving shadowing and per-boundary ownership/thread checks. Preserving alias provenance after storage and addressable move-only resource capabilities such as `TextBuffer` through a borrowed closure remain |
| Strings and console | Implemented | Owned UTF-8 strings, exact byte equality, templates, typed formatting, checked `byteAt`/`copyBytes`, `byteLength`, `isEmpty`, and explicit move-only `std/text` `TextBuffer`; grapheme-aware `length` remains planned |
| JSON | Implemented lossless DOM plus first derived codec tier | Source-backed `std/json` exports recursive owned `JsonValue`, nominal validated `JsonNumber` with private exact text and checked integer/float conversions, positioned `JsonError`, strict UTF-8 JSON parsing including surrogate-pair escapes, and compact lossless number forwarding. Stage 0 and the fixed-point compiler execute that DOM module, including recursive Array/Map/JsonNumber cleanup and borrowed Map-entry iteration. Stage 0 additionally materializes `decode<T>` / inferred `encode` for ordinary flat value structs with public non-optional String/boolean/integer fields, exact-width integer parsing, field defaults, required-field errors, recursive unknown-field skipping, duplicate rejection, and declaration-order output. Nested typed aggregates/collections/options/floats/policies and native fixed-point materialization remain staged |
| Integer safety | Implemented | Checked arithmetic, explicit wrapping/saturating operations, and `TargetInteger(value)` construction that lowers range-contained pairs directly and checks narrowing/signedness-risk pairs; lossy and floating-point conversions remain |
| Transparent type aliases | Implemented foundation | `type Transform = (value: i32) => i32` names existing function, aggregate, collection, nullable, view, and nested types without changing representation or nominal identity; local/exported/selective/namespace use, construction/static lookup, recursive-chain diagnostics, editor support, and native parser/module parity work; generic alias parameters and opaque/newtype identity remain |
| Generators | Implemented synchronous tier plus composable async tier | Explicit `Generator<T>` and `AsyncGenerator<T>` sequences, terminal `Return`, and `throws E` advancement from `std/iteration`; both forms are cold move-only heap frames with typed `yield`/`return`, explicit `try`/`attempt` on fallible advancement, deterministic return/error/early-drop cleanup, editor support, and native-parser parity. Async `.next()` returns a one-shot `Task` that resumes the persistent stream frame through `if`, `while`, `break`/`continue`, built-in collection `for...of`, borrowed statement `match`, and ordinary awaits; caller cancellation joins the active advancement before cleanup and overlapping advancement is rejected. Async iteration sugar, consuming/value-producing suspending matches, generator methods, borrowed inputs/yields, and sent values remain |
| `comptime` | Planned experiment | No compile-time execution model committed |
| Inline assembly | Planned design | Explicit `unsafe` boundary with `in` / `inout` / `out` operands; statement-first lowering, machine constraints, clobbers, target pruning, and backend portability remain to be designed and tested |

## Ownership and collections

| Area | Status | Current boundary |
| --- | --- | --- |
| Moves and deterministic `deinit` | Implemented | Flow-sensitive cleanup across return, throw, loops, and matches |
| Explicit `copy` / `move` expressions | Implemented foundation | Readable contextual prefix keywords; `copy` supports cleanup-free values, owned String, recursively copyable Z structs/enums/arrays, and `.zd`-proven native copies, while `move` transfers unique whole-binding owners and diagnoses later source use; custom copy hooks and direct container-element extraction remain separate design work |
| `in` / `inout` / `out` | Implemented synchronous projected-field tier | Explicit declaration and call-site capabilities. Stage 0 and native call contracts accept direct `in`/`inout` paths through fixed-layout value-struct fields, permit disjoint siblings, and reject repeated or parent/child overlap; native C passes field addresses directly. `out` remains whole-binding, while ARC fields and mutable method receivers, dynamic indexes, projected Slice conversion, and suspension remain conservative. Both semantic frontends additionally permit a direct field view to coexist with disjoint sibling mutation |
| Unified loan checker | Implemented foundation | Call-, task-, receiver-view-, and Arena-region lifetimes share one root/capability/lifetime representation and conflict matrix; cross-thread loans remain to integrate |
| Fixed arrays | Implemented | Checked indexing and reverse element cleanup |
| `Array<T>` | Implemented | Empty `Array<T>()` and source-ordered populated `Array<T>(...)` construction, growable owned storage, move-aware elements, checked indexing, reverse destruction, and consuming zero-copy `freeze(): readonly Array<T>` publication. Fixed-point native lowering retains ARC class identity when an indexed element becomes an owned local and releases class elements directly during collection teardown; explicitly reserved capacity and populated construction directly inside suspended async frames remain later lowering slices |
| `Map<K, V>` | Implemented hashed tier | Explicit `std/collections` import; amortized O(1) open-addressed lookup, owned value-storage transfer, deterministic replacement/removal/delete/clear, consuming zero-copy `freeze(): readonly Map<K, V>`, `Option<view V>` lookup for values tied into the unified loan checker, and retained `Option<V>` lookup for Z-class, Objective-C, and ARC-managed function identity. Function insertion retains, lookup returns an independently retained handler, removal transfers the stored handle, and destructive operations release exactly once. Native construction/destruction for move-only C++ values, borrowed `Map.Entry<K, V>` iteration with whole-entry or `{ key, value }` patterns, mutation exclusion and editor support, built-in scalar/String/enum keys, and readonly nominal `Hashable` keys through `std/hash` are implemented. Frozen Maps retain normal deterministic cleanup and may participate in deeply readonly cross-thread class graphs when their contents are shareable. The fixed-point compiler emits the complete scalar/nominal-key mutation surface and executes function-valued Maps through the ordinary typed callable handle, including transparent callable aliases imported from separate modules and retained callable copies across ordinary method calls; the message-router differential fixture proves repeated installation of one owned capture, lookup invocation, and exact release. Weak values, native keys, and copy-only native values remain |
| `Set<T>` | Implemented hashed tier | Explicit `std/collections` import; amortized O(1) open-addressed membership, owned unique-value transfer, insertion status, deterministic duplicate/removal/delete/clear cleanup, consuming zero-copy `freeze(): readonly Set<T>`, owned `Option<T>` removal, borrowed element iteration with mutation exclusion and editor support, and the same built-in or readonly nominal `Hashable` contract as `Map`. Frozen Sets retain normal deterministic cleanup and may participate in deeply readonly cross-thread class graphs when their contents are shareable. The fixed-point compiler emits scalar/String/enum/custom-element hashing and equality, complete mutation and cleanup, plus same-Arena provenance for named view-bearing `Hashable` elements |
| `Iterator<T>` | Implemented synchronous tier | Explicit `std/iteration` import; generic nominal conformance, `next(inout this): Option<T>`, explicit mutable loans for stored value iterators, unique temporary iterator storage, owned element transfer and cleanup, native-parser parity, and editor support; consuming, mutable-element, move-only foreign-element, and async iterators remain |
| `Slice<T>` | Partial | Non-escaping parameters plus direct-awaited and scope-bounded child-task borrowing from fixed and growable owners, including cleanup-bearing Z and move-only C++ elements. The fixed-point synchronous compiler emits standalone two-word Slice parameter types, checked indexing/length, fixed-array/`Array<T>`-to-Slice call projection, and positional Slice source/rest lowering without allocation or cleanup. Returned/stored and cross-thread Slices remain |
| Owner-tied `view T` | Implemented narrow tier | `const value = view owner.field/index` local projections; direct field/index results and niche-backed `Option<view T>` lookups from synchronous value-struct methods; synchronous module-function `view T` and `Option<view T>` returns projected from immutable `in` value owners; one-owner local value structs; and same-owner `Array<ValueStructWithViews>` containers established by populated construction, a direct first `push`, or agreeing exhaustive `if`/`match` branches. A synchronous borrowed value-struct method or module function may return a named aggregate containing multiple direct view fields from one owner; wrappers may forward that result or an immutable `in` aggregate while preserving provenance. Immutable object destructuring produces independent view bindings whose collective final use closes the shared loan. Both emitters lower the aggregate to an ordinary C struct of borrowed pointers, and native destructuring evaluates the producer once before field projection; no allocation, retain, or runtime provenance tag is added. Mixed owners within one result, nested borrowed fields, ARC-class or mutable/consuming receiver producers, throwing/async producers, mutable destructuring, and further storage are rejected. Multi-source direct, optional, and aggregate returns conservatively loan every possible input; both frontends enforce owner mutation/move exclusion and precise last-use release inside ordinary and value-producing blocks. Both semantic frontends record direct fixed-layout field paths so a live field view permits disjoint sibling mutation while blocking the viewed field and its parents; native flow state keeps view-value ownership separate from last-use loan liveness across branches and loops. Dynamic indexes and ARC paths stay whole-owner conservative. Views remain inferred const and read-only, support ordinary by-value loads when `T` is cleanup-free and copyable—including contextual `match`/`if` arms—plus synchronous `in T` forwarding and proven nonescaping inline capture. Read-only `view Array<T>` indexing/length/iteration and `view String` inspection/comparison/interpolation preserve the pointer representation through both frontends; no mutation through a live element view or class owners |
| `std/memory` `Arena` | Implemented narrow tier in both frontends | Stable paged region allocation, inferred owner-tied views, one-owner view-bearing value structs, compatible-owner Arrays, Map values, and readonly Hashable Set elements, variant-sensitive enum edges, same-Arena `Option<view T>` recursive links, and synchronous returned `readonly struct` graph bundles that close exactly one Arena over their dependent storage; the production parser now closes its completed `Array<ParsedModule>` into a returned `ParsedModuleBatch` root consumed by resolution and emission. Reverse `deinit`/ARC/native RAII cleanup skips borrowed fields and destroys dependent bundle fields before the Arena, shared loans exclude reset/move until an explicit region-closing construction, aliases preserve semantics, and proven inline captures remain nonescaping. Mutable Arrays, Maps, and Sets establish provenance on first insertion; ownerless enum/Option alternatives contribute no edge, one real owner is retained conservatively, and mixed owners are rejected. View-bearing enums and associative values require named value structs; optional view links and Map lookups use nullable pointers with no tag or cleanup; the fixed-point emitter owns the full Map and Set mutation surfaces for supported built-in and readonly nominal `Hashable` identities; regions remain synchronous and single-threaded |
| General returned/stored borrows | Planned beyond closed regions | Direct, optional, and one-owner retained-aggregate immutable receiver/parameter provenance, provenance-preserving aggregate forwarding and object destructuring, same-Arena fixed composites and collections, exhaustive branch joins, variant-sensitive ownerless enums, same-Arena optional recursive links, Arena-owned Map/Set edges and removal, and one-owner synchronous returned graph bundles are implemented; loop-carried provenance, multi-owner fields within one returned aggregate, nested aggregates, class alias safety, nested/multi-edge region bundles, generator/async transfer, and general lifetime relationships remain open |
| ORC cycle collection | Planned | `Weak<T>` works now; arbitrary strong cycles are not collected |

The ongoing empirical record is
[`ownership-pressure.md`](ownership-pressure.md). The first desktop probe shows
the core model handling ARC application state plus move-only documents cleanly,
while the value-struct lookup probe now crosses the first non-escaping wall with
an inferred receiver-tied view.

## Modules and tooling

| Area | Status | Current boundary |
| --- | --- | --- |
| Z source modules | Partial | Explicit exports, namespace/selective imports, aliases, cycle diagnostics, canonical native type identity across intermediate modules, and canonical qualified standard-module field types such as `objc.Connection` while expression bindings remain module-mangled. Stage 0 supports the broader language; the fixed-point native driver resolves and lowers its complete 39-module self-hosting graph plus the demonstrated application subset |
| `std/sync` `Once<T>` | Implemented synchronized main-lifecycle ARC tier | A module-level `const` may hold a statically empty `Once<T>` for a Z ARC class whose lifecycle belongs to `thread.main`. `initialize(move value)` publishes one strong root and returns a move-only `OnceLifetime<T>` whose deterministic cleanup removes that root on main. Mutex-protected `get(): T` may retain the identity on any Z-managed thread; repeated direct gets and structurally transparent exported accessors share one canonical compiler identity for synchronous alias-exclusivity checks. Member affinity still restricts what the caller can use, affine ARC is atomic, and final worker release is routed to main. Construction errors occur before publication; never-initialized, closed-lifetime, duplicate-initialize, and closed-cell reinitialize traps are distinguished. Retrieval racing cleanup is memory-safe but outcome-ordered, so workers that may retrieve must join before lifetime cleanup. Checked foreign-thread runtime entry can retrieve the cell through `thread any` callbacks and embedding exports; turning arbitrary foreign threads into Z executors, value/native payloads, optional cells, replacement, and concurrent weak upgrade remain deferred |
| `std/sync` `Mutex<T>` | Implemented scoped exclusive shared-identity tier | `const state = Mutex(value)` owns an atomically retained handle to address-stable storage backed by a real OS mutex. `withLock((in value) => ...)` and `withLock((inout value) => ...)` synchronously block the current OS thread, expose a non-escaping read or read/write borrow, and release the mutex on normal return or typed failure. Independently owned results may leave; `await`, escaping capture, and borrowed/view results are rejected while locked. A native-worker closure may retain the same Mutex when `T` is transferable and safely destructible on the worker; the caller remains valid and final release destroys the cell once. Main-isolated and otherwise unsafe payloads are rejected at the thread boundary. Read/write locks, atomics, condition variables, semaphores, asynchronous/timed/nonblocking acquisition, explicit handle copying, and public guard values remain deferred |
| CLI | Implemented project-target slice | Stage 0 and the fixed-point native `z` accept a source file or a `z.json` project for `check`, `run`, and read-only source `emit`, and build named executable, static-library, or shared-library targets from a project directory. Every manifest target has `name` and `entry`; omitted `kind` means executable, while explicit source files override entry selection without discarding target configuration. Tests, `--release`, program arguments after `--`, and live run/test I/O remain. Versioned shared-library policy, Windows import libraries, header-only emission, and the remaining production options are later layers |
| Native tests | Implemented expectation tier | Top-level `test "name" {}` declarations work in ordinary `.zs` modules, share private module scope, remain in native-frontend parser/semantic parity, and are omitted completely from production emission. Both Stage 0 and the fixed-point native `z test <file.zs>` discover synchronous tests through that file's project-owned imports and execute one native runner. Imported `std/test` provides statement-bounded `expect(...).toEqual(...)` and cleanup-preserving `fail(...)`; failures return owned diagnostics with source locations and later tests continue. Filtering, reusable assertion helpers, project-wide discovery outside the selected import graph, and async tests remain |
| Checked program metadata | Implemented in Stage 0 and the fixed-point native compiler | `z metadata <file.zs | project>` emits schema-versioned JSON containing exported symbol signatures and resolved calls whose targets are public Z symbols. String, numeric, boolean, and null literals remain explicit evidence; other arguments expose only their checked types. Zapp consumes this compiler-neutral artifact to derive typed service bindings without source scanning or a hand-maintained schema. Richer documentation metadata and compatibility policy beyond schema 1 remain |
| System standard APIs | Implemented foundation | Default `std/fs` and `std/process` modules; owned UTF-8 and arbitrary-byte reads, canonical paths and current-executable discovery, recursive directory creation, borrowed writes/process argv, same-filesystem atomic replacement, owned arguments, direct no-shell child launch, typed OS failures, and move-only RAII `fs.Lock` values for blocking exclusive interprocess filesystem locks with consuming early `unlock()`. Ambient `process.args()` and `process.executablePath()` are executable-target capabilities; library targets fail closed until an explicit host-argument runtime contract exists |
| Native backends | Partial | Readable C, C++20, Objective-C ARC, and Objective-C++ source generation |
| Foreign Interface IR | Implemented foundation | Raw declarations, API-note merge, normalized contracts, source locations, and availability metadata are separate. The real Clang producer frames functions, scalar typedef evidence, nominal enums, typed native constants, and record layouts/fields as a versioned, length-prefixed `ZFDCL` artifact; unrelated unsupported declarations are projected out while exact native spellings remain on functions, so only a contract that actually depends on unsupported boundary evidence fails closed. The standalone native driver discovers an optional adjacent `.zd`; safely representable header declarations and plain value-ABI functions require no empty sidecar, while operations needing semantic facts fail at their use sites. It prefers the packaged producer beside its own executable, falls back to `PATH`, owns the decoder, and rejects malformed streams or unsupported contract use. Project-local `.z-cache/foreign` identities include module/header/contract, include directories, and target settings; adapter SHA-256 metadata covers Clang's preprocessed header view, so unchanged imports skip AST production and transitive changes invalidate. The Z-owned `.zd` parser/normalizer verifies inferred scalar functions; decimal, symbolic scalar, or nominally enum-backed integer-status contracts; recursively copyable and move-only C records; opaque C-union output storage with supported scalar/enum discriminants; pointer-bearing cleanup-free payload records retained as view-only types; lifetime-bound `const char *` field projections; owned or conservatively borrowed opaque pointer results/outputs; nullable borrowed `view cstring` results; const-checked `in` and mutable `inout`/`out` scalar pointers with ordinary definite initialization; pointer-only null arguments; and fixed producer-proven constants against those declarations. Fixed ABI positions are omitted from the safe signature but retained in an ordered call plan and reinserted for both direct calls and generated status adapters; null-only positions remain visible and accept only literal `null`. Pointer-handle cleanup proves exact `T *`/`T **` and release signatures, preserves direct `in`/`move` ABI calls, cleans status-produced owners on failure, supports null-guard narrowing, and lowers `Option.fromNullable` with one producer evaluation. An exact header-derived borrowed pointer result is a nullable non-escaping view with no cleanup; `borrowed from owner;` additionally records one immutable input handle as provenance so the result can remain `view T` or `Option<view T>` without outliving or moving that owner. Header-proven character pointers similarly remain direct `view cstring` values, preserve nullability, and reuse explicit owner provenance. Owner `invalidates` effects and declared foreign `lifetime` identities reuse that loan graph to reject a direct native call while an outstanding child or text view may be invalidated, without changing the pointer ABI or adding a runtime check. Symbolic facts must name a producer-proven constant with the exact scalar or enum return identity. Enum errors remain source-nameable imported types through native sema, `Result`, matching, and C emission, while explicit integer construction uses their producer-verified underlying type. Ordinary enum parameters and producer-proven constants preserve that same nominal identity through namespace/selective imports, call checking, exported expression evidence, and C emission; contextual integer literals are rejected at enum boundaries. Copyable foreign structs remain source-nameable through nested construction, field access, direct value/pointer calls, and C emission without wrappers. Contracted writable union pointers lower to exact opaque native storage and address-taking; discriminated members lower as borrowed payload views, while by-value union construction fails closed. Those checked callables enter native sema through ordinary module signatures while uncontracted symbols fail closed. Native lowering emits each required header, direct scalar/record/handle/text/union-output calls, and one-call status adapters that construct `Result<void, E>`. Foreign-cache eviction, broader `.zd` facts and declaration records, and richer native hierarchies remain |
| Language server | Partial | Diagnostics, semantic highlighting, contextual selective-import/object-pattern completion, hover, and Z/native definitions; `copy`/`move` incompatibilities diagnose live and keyword hover explains inferred type, capability source, copy cost, and source invalidation. The VS Code/Cursor extension also associates `z.json` with the bundled project schema for manifest completion and structural diagnostics. Native hover separates the source-level Z signature from ABI and availability details, uses source-nameable handle types, and resolves the selected Objective-C receiver instead of merging unrelated selectors. Broader incomplete-pattern recovery remains |
| Native definitions | Implemented slice | Namespace/selective C symbols, Objective-C members, and generated Swift compatibility declarations jump to their native headers |
| Self-hosting | Partial compiler | Stage 0 remains the trusted Bun/TypeScript seed, foreign-metadata producer, and Swift-target preparer. The fixed-point native compiler owns Z lexing, parsing, module resolution, semantic evidence, ownership-aware lowering, diagnostics, C emission, its 39-module standalone driver, `z.json`, `check`/`emit`/`build`/cached `run`, and adjacent Clang metadata-adapter discovery. Generation one rebuilds generation two to byte-identical C before publication. The in-process parser now closes each completed module Array into an Arena-owned `ParsedModuleBatch`; resolver and emitter borrow that root while the recursive standalone-driver discovery path retains its ordinary single-module owner. Native execution covers ownership-bearing tasks, typed failures, cancellation, `thread.spawn`, main-executor handoff, top-level one-select unsafe value expressions, one heap-owned invocation frame for bounded linear, `if`, `match`, and `while` suspension, readonly nominal `Hashable` Map keys and Set elements through native `Hasher` lowering, transparent aliases, first-class synchronous function values, consuming `move this` value-struct methods with guarded receiver cleanup and sole-owned-field transfer, cleanup-aware immutable object destructuring with explicit copy/move, move-spread transfer with reverse-order cleanup of overridden owned fields, demand-driven concrete generic value structs across modules with recursive layout/cleanup/construction/field/spread/destructuring plus declared instance/static method specialization, inferred static factories, independently generic methods, demand-specialized generic ARC classes with atomic retain/release and owned-field cleanup, and demand-specialized generic free functions with recursive dependent calls, recursively nested fixed-array values/indexing/copy/destructuring/iteration across module calls and returns, including reverse-order cleanup and initialized-prefix cleanup for ownership-bearing element graphs, fixed-position and zero-copy rest `Array<T>`/`Slice<T>` destructuring with owner-tied element/Slice views, synchronous Slice parameters and fixed-array/Array-to-Slice call projection, zero-copy collection `freeze()` publication, and synchronous `on thread.any` free functions/contextual closures with atomic captured environments. Direct functions use static callable handles; capturing expression closures own refcounted environments; typed throwing calls retain `Result`; and function-valued Maps, including frozen readonly Maps, retain, retrieve, transfer, and destroy the same handles. The `while` tier preserves `break`, `continue`, `return`, `throw`, direct synchronous `try`, per-iteration cleanup, and cancellation without per-iteration allocation. Native rejection parity covers off-main access through worker captures and lexical match loans held across suspension while preserving inherited main-executor proof, ordinary async parameter borrows, consuming matches, persistent async-generator frames, weaker local callable assignment, and non-shareable arbitrary-thread closure captures. A graph-aware source-mapped lowerability preflight reports `Z0700` for ordinary async and non-tail calls to suspending main-executor functions, plus `Z1000` for custom constructors on generic aggregates, two-level static specialization on generic owners, traits, generators, unsupported collection iteration, unsupported fixed-point collection representations, unsupported explicit-copy graphs, cleanup-bearing `Mutex.withLock` results and optional field views, recursively owned value capture in expression-bodied `thread.spawn`, unsupported native template-part types, object-rest destructuring, value-producing loops, multi-statement unsafe expressions, and other syntactically or semantically settled body gaps before raw IR errors can leak; uncatalogued lowering and C-emission failures are labeled as internal compiler errors. General nested suspension, suspending `for`, `try await` inside the placed loop, dynamic delays, cross-executor loans, weak/native collection elements, suspending or method-based arbitrary-thread callables, remaining explicit-copy types, owned lock results, worker-context destruction, complete native formatting, the remaining production command surface, migration of remaining expected lowering gaps from the internal-error fallback into coded boundaries, and replacement of the trusted metadata/Swift preparation tools remain staged. See [the continuation point](#self-hosting-continuation-point) and the async/concurrency rows below for the detailed boundary. |

The fixed-point async boundary has narrowed since the compact self-hosting row
was written: a direct call to an imported async free function with a
cleanup-free signature now uses a heap-owned task adapter. It may complete
immediately or begin with one direct `await scheduler.yield()`; the latter
stores its arguments, requeues once, observes cancellation, resumes a
synchronous tail, and transfers its result exactly once under strict C
compilation. `Z0700` remains for broader suspending bodies, including general
async methods; one direct awaited non-consuming ARC class method uses the bounded
one-yield frame while retaining its receiver and transferring a cleanup-bearing
result exactly once. A directly called async adapter with one tail
`return await handler(...)` now owns a heap parent frame: cleanup-bearing value
parameters and borrowed inputs remain valid while its dynamic child runs, child
completion wakes the parent, cancellation propagates to the child, and an owned
result transfers or is destroyed exactly once. General suspending bodies with
locals/control flow around a child await, and named async-function value
conversion remain deferred. The same single-tail-await body is executable on a
non-consuming ARC class method, whose parent frame retains the receiver until
child completion or cancellation. Straight-line method locals before that
await are frame-owned too, including cleanup-bearing values lent to the child.
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
Zapp composition tier is multiple sequential suspension sites in one function.

`ZFDCL` version 11 additionally transports Clang's flag-enum classification,
so native bitwise expressions retain their nominal imported type without an
explicit annotation. Normalized C records also retain their exact canonical
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
Objective-C class properties, optional property access,
broad/header-only native-driver discovery, Objective-C protocol runtime checks,
general Z-class runtime checks, and Objective-C++ selection remain staged.

The fixed-point callable tier also composes through aggregate ownership:
classes and structs may own supported Array, Map, and Set fields without C
declaration-order sensitivity, and synchronous throwing methods lower through
the same `Result<T, E>` ABI as ordinary throwing functions. The maintained
message router proves this with an ARC `Router` owning
`Map<String, Handler>`. Async throwing methods remain an explicit `Z1000`
staging boundary. Imported transparent callable aliases also retain the source
signature required for contextual closure lowering while sharing the declaring
module's canonical callable ABI. The router's companion C-callback entry proves
that a checked escaping native callback can own that reusable class graph and
release it deterministically.

## Foreign interfaces

| Boundary | Status | Current boundary |
| --- | --- | --- |
| Z-to-C exports | Implemented checked value-ABI artifact and embedding-runtime slice in Stage 0 and the native compiler | `export c function` distinguishes a deliberate global C ABI symbol from an ordinary Z module export while remaining importable and callable from Z. The implemented tier emits a private implementation, exact public wrapper, and C/C++-compatible header for scalars, owned UTF-8 `String` inputs projected from validated non-null `const char *`, nested by-value `c struct` values, and fixed-representation payload-free `c enum` values; validates text and enum inputs at the C boundary; rejects unsupported ownership, types, and effects in Z; and checks duplicate symbols across the linked module graph. `z build <project-directory> [--release]` uses the manifest's required `name` and `entry`; `static-library` and `shared-library` make `main` optional and publish the same guarded header plus the selected host-native artifact under `build/`. Generated target-scoped initialize/shutdown functions bound calls from host-created threads, count live entries atomically, leave admission open on `BUSY`, and close it on `DRAINING` while an executor-bound root finalizer is queued. Optional `target.runtime.initialize` retains one cleanup-bearing entry-module owner—such as `OnceLifetime<T>`—until generated shutdown; main-bound roots require host main-thread proof and release scheduling. The native compiler preserves the same manifest, root storage, teardown shape, per-export foreign-thread route installation, and executor-bound ARC release routing: release enqueues the extracted finalizer through the installed route and uses the same finalizer inline when no route is active. Native lowering now owns `Mutex<T>` aggregate fields, borrowing and `inout this` aggregate methods, atomic ARC, synchronized `Once<T>`, expression- or block-bodied `withLock` calls with cleanup-free scalar captures, and the first capture-free scalar worker task; `this`/ownership-bearing worker captures and complete async executor orchestration remain application-root gaps. Project `z emit` exposes the complete generated translation unit without writing an artifact. Native semantic evidence preserves the C representation facts, native lowering emits the wrapper/header/lifecycle shape, and handwritten strict-C consumers exercise both linkage modes. `String` results, zero-copy borrowed `cstring` inputs, slices, typed-error projection, owned results, callbacks, async exports, versioned shared-library packaging, header-only emission, and generated `.zd` metadata follow |
| C functions and scalars | Implemented | Clang AST signatures, selective imports, aliases, variadics |
| C records, unions, and enums | Partial | Complete supported struct layouts, nested records, nominal enums, constants, and `.zd`-classified move-only by-value resources. `export type T { move; deinit release; }` keeps the native record ABI while `owned;` and non-escaping `borrowed;` producer facts govern cleanup; canonical Clang identity carries facts across typedef aliases such as raylib `Texture` → `Texture2D`. Imported C unions receive ABI-preserving storage and may be initialized through contracted `out Union*` parameters. A checked `discriminant` contract maps constants to tag-only or cleanup-free struct payload variants; Stage 0 and the native self-hosting frontend both require borrowed matches and lower them to a direct switch with active-member views, while an explicit fallback preserves unknown tags. Pointer-bearing payload structs are retained as view-only records: safe scalar/enum fields remain visible, raw pointer fields are hidden, and `.zd` may project a compatible `const char *` field as `view cstring [| null]` tied to a declared foreign lifetime. `invalidates lifetime;` rejects calls that may replace that native storage while a projected view remains live. Uncontracted scalar/enum union members remain available only through a local `unsafe` proof. Nominal imported enums convert explicitly outward through checked integer construction such as `u32(value)` while implicit and integer-to-enum conversion remain rejected. Other pointer field shapes, general native lifetime relationships, and by-value union construction remain deferred |
| Clang header ingestion | Implemented spill-backed slice | Header ASTs and macro preprocessor output are imported directly from Clang. Ordinary imports keep the fast bounded pipe path; process-buffer or decoded-string overflow retries through a unique spill file, removing the former 64 MiB plain-C ceiling and importing SDL3's 70.8 MB `SDL_render.h` AST unchanged. Z currently materializes the completed JSON document for semantic filtering; incremental parsing remains a future memory optimization for substantially larger headers |
| C macros | Implemented literal slice | Active object-like integer-literal macros defined by the imported header receive target-correct scalar types, namespace/selective imports, direct native emission, completion, hover, and definitions; function-like, string, alias, and expression macros remain |
| C pointers and statuses | Partial | Safe opaque handles and record borrows use adjacent `.zd` contracts, including flat basename discovery for qualified includes; standalone `.zd` checking validates the active source against the real header. Fixed `const char *` parameters inferred with `_` expose an intrinsically borrowed `cstring`; owned Z `String` values project their existing NUL-terminated storage for one direct native call without a copy, move, or cleanup loss in Stage 0 and the fixed-point compiler. Owned nullable `T *` results and `T **` outputs receive deterministic cleanup and expose source-nameable namespace types such as `sqlite.sqlite3`; those owners may persist in ARC class fields and close at final release. By-value C resources use the separate record-resource tier above. Anonymous typedef enums import with their cases, expression-valued integer macros compose from other header macros, and `void throws _ { success CONSTANT; }` projects integer or integer-backed enum statuses into allocation-free typed errors while activating owned outputs before propagation. Named `project ...: Slice<u8>` contracts combine native byte-pointer plus `size_t` pairs into one borrowed argument and lower directly back to `.data`/`.length`; `project inout` additionally requires mutable native storage and explicit Z call-site mutation. Enum-member literal parameters plus explicit `cstring`, declaration-only `clong`, and an owner-tied byte-callback connection provide closed, type-checked C variadic overloads, proven against libcurl. `connection throws _` installs a separate context/callback option pair as one operation and returns a move-only `native.Connection` whose lexical loan guarantees callback removal before owner destruction. Null-only parameters safely hide unsupported pointer values; nullable `view cstring` results borrow their single pointer input and copy into owned `String`; fixed native sentinel parameters preserve the verified ABI while disappearing from safe Z calls; nullable declared handles lift into niche-backed `Option`; owned handles with explicit transfer/destruction facts cross `thread.spawn`. Broader C ABI vocabulary, resource lifetime provenance, general element-typed/retained buffer projections, general callback projections, general pointer/view contracts, and internal toolchain notes remain |
| Native callbacks | Partial | C call-only and escaping callbacks use `.zd` with named context, explicit `invoked once`/`invoked repeatedly` cardinality, and exact release contracts; generated Swift/Objective-C static methods may refine ARC-owned block parameters without inventing context/release ABI. The fixed-point compiler now owns the first retained C-callback path: it verifies callback/context/release ABI positions, hides the context machinery from the Z signature, moves an expression-bodied closure into a heap-owned native box, invokes it through the typed C trampoline, and destroys it exactly once through the declared release callback. Adjacent `.zd` files augment rather than replace ordinary safely inferred header functions. `thread caller` preserves thread-local ownership, while `thread any` emits atomic closure ownership, checks conservative concurrent-shareability, and automatically enters the runtime captured at registration around both callback invocation and native release. This bounded entry now covers C trampolines and ARC Objective-C blocks, including Swift-generated block APIs: their callback boxes keep the executor alive, nested entry restores prior TLS state, and synchronized `Once<T>`/`Mutex<T>` access plus executor-routed ARC cleanup remain available without making the foreign thread an executor. Nested `failure N;` or `failure CONSTANT;` contracts allow compatible throwing Z function values: ordinary returns pass through, while thrown payloads are destroyed and narrowed to the declared callback ABI result. `async completion;` requires exact-once delivery, preserves the raw overload, synthesizes an infallible task, and traps duplicate native completion before re-entering completed storage; a never-invoked callback leaves the task pending. `async completion(value, error) { return value; throw error; }` projects a nullable Objective-C error into an owned `Task<T, E>`. Cancellation without a native hook waits for completion before frame destruction. A named/imported `TaskScope` owns repeated callback-created main-executor work and joins it without detachment; returned `TaskControl` identities expose admission and per-operation cancellation without duplicating join ownership. The current C callback tier permits one named byte projection per callback, although its length may multiply several native factors; failure constants are checked for integer/enum category, while exact scalar width and range validation remains. Fixed-point direct context-free callbacks, block-bodied first-class closures, `thread any` callback entry, instance projections, weak cross-thread capture, ownership-bearing completion values, native cancellation hooks, callback-payload preservation, and broader callback projections remain |
| Native availability | Implemented host slice | Explicit `z.json` platform/minimum target, introduced/obsoleted errors, deprecation warnings, native source locations, and matching Clang/Swift deployment flags; cross-compilation and runtime guards remain |
| Native header/library search and linkage | Implemented host slice | Validated, deduplicated `target.includeDirectories` and `target.link.directories` resolve from `z.json`; library names become host-native arguments, and Apple framework names use explicit `target.link.frameworks` without requiring Swift; package discovery, raw linker flags, and cross-platform library resolution remain outside the project contract |
| Raw native source | Implemented narrow tier | `raw c` / `raw cpp` / `raw objc` standalone expressions lower through isolated helpers with explicit `using (in ... / inout ... / out ...) : T` contracts; named functions use `= raw <language> { ... }` and their ordinary parameters/result as the boundary. Native `return` cannot escape the helper, `out` participates in definite initialization, dialect selection is automatic, `on thread.main` composes, and Clang diagnostics map to `.zs`. Raw shape restrictions are validated before generic materialization, ordinary fields named `c`/`cpp`/`objc` remain ordinary Z, and embedded source cannot reference compiler-owned `Z_` or `_z_` identifiers. Tier 1 accepts ABI-stable scalars, `cstring`, and imported native types; async/throwing/generic/method bodies, `move`, Z-owned representations, and embedded-language completion remain |
| Inline `unsafe` Z | Implemented narrow tier | Synchronous `unsafe { ... }` keeps Z syntax and types while allowing a compatible native `char *` result to be asserted locally as `cstring`, retaining another unsupported pointer as a scope-confined opaque identity, or asserting the active scalar/enum member of imported C union storage initialized through a checked boundary. The expression form uses `select` and can produce representable scalars or independently owned Z copies. Opaque and locally asserted borrowed values may compare with null or pass through exact matching native pointer spellings, but cannot be inspected, selected, stored outside the block, returned, captured by a closure, laundered through an ordinary Z call, or used in async functions; `String.from` is the explicit owned-copy boundary for asserted `cstring`. Pointer-bearing by-value records remain unavailable even inside `unsafe` and require `raw` in this tier. Inferred capabilities, pointer arithmetic, and a general raw-pointer type remain deliberately absent |
| Objective-C | Partial | ARC classes/fields, methods, properties/global object constants, imported property ownership (`weak`/`strong`/`copy`/`assign`), method-parameter `id<Protocol>` qualifiers, labels, nullability, niche-backed `Option.fromNullable`, dynamic `id` class narrowing with `instanceof`, owned `String`/`NSString` copies, escaping blocks, persistent observer tokens, lifetime-safe `std/objc` target/action connections, checked Z-class protocol adapters with owned weak-property bindings, and deterministic `objc.register` add/remove guards for retained protocol handlers. Fixed-point `ZFDCL` version 11 carries interfaces, protocols, methods, properties, exact ABI spellings plus semantic type/nullability identity, qualifiers, ownership, getter/setter selectors, availability, async indices, and Clang flag-enum classification into native normalization. The native resolver attaches Objective-C interfaces as class contracts and protocols as trait contracts, resolves inherited/overloaded selectors by argument shape and labels, accepts non-null subclasses where a nullable superclass reference is expected, preserves nominal imported flag enums across bitwise expressions, recognizes exact canonical C-record aliases within one producer contract, projects representable inherited instance properties through ordinary member lookup, and natively rejects invalid `objc.register` protocol owners and teardown pairs. The fixed-point emitter lowers direct imported class and instance messages, custom property getters and writable setters, ARC object-return storage, `instanceof` to `isKindOfClass:`, contextual owned `String` conversion to `NSString`, `String`-to-`const char *` arguments, and complete `objc.register` plans into owned protocol adapters plus ARC guards whose final release sends the verified remove selector once. Guard-bearing Objective-C fields are cleared before Z ARC class storage is freed, and freshly bootstrapped fixtures prove getter/setter dispatch, readonly-property rejection, inherited reference assignment, dynamic class narrowing, canonical record aliases, plus add/callback/remove ordering. Foreign reference properties are message metadata rather than recursively embedded Z storage, so stored-view validation stops at that identity instead of traversing an SDK object graph. The standalone driver automatically writes `.m` and enables ARC. Class properties, optional property access, protocol/general Z-class runtime checks, broad/header-only native-driver discovery, Objective-C++, and canonical identity across independent producer contracts remain staged |
| C++ | Partial | Hierarchical/selectively aliased namespaces, typed overloads, records, and `.zd`-contracted copyable or move-only RAII values; move-only values work in synchronous locals/calls/returns, Z structs, dynamic arrays, named enums, compiler `Option`/`Result`, direct async locals, owned async parameters, scoped immutable async borrows, direct-awaited and scope-bounded child-task mutable async borrows, whole Z async value aggregates, fallible async results, and explicit native-thread transfer when `.zd` separately guarantees transfer and receiving-thread destruction; named references and receiver qualifiers map to existing Z capabilities with direct native lowering; reference returns, child-task output async borrows, ARC/closure storage, native sharing, capability-changing overloads, and templates remain |
| Swift via Objective-C | Implemented slice | Generated compatibility header, classes/properties/methods, automatic local dylib build/link, declared-target symbol-graph import of Swift `@MainActor` type/method isolation, qualified `.zd` threading contracts for escaping blocks, and exactly-once callback-to-task synthesis with owned nullable `NSError` failures that resumes safely from arbitrary threads before AppKit work returns to `thread.main` |
| Swift value via C++ | Implemented probes | Native static construction, associated-value enum case factories, const/mutable instance methods, struct return/copy/aggregate storage/round-trip/destruction, and exact owned `String` returns without handwritten shim |
| Broader Swift surface | Planned vertical slices | Length-aware `String` inputs, property sugar, generics, protocols, errors, async, packages; Swift 6.2 currently withholds noncopyable values and async functions from its generated C++ interface |

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

| Area | Status | Current boundary |
| --- | --- | --- |
| Async syntax and typing | Implemented | Functions/methods, `await`, `task`, task scopes, typed errors, direct-call and block `await on thread.main` / `task on thread.main` placement, and executor-local `await scheduler.yield()` |
| Stackless task frames | Partial | Scalars, owned String/TextBuffer, cleanup-bearing fixed arrays, growable arrays, copied Slice descriptors, owned structs/enums/classes, direct move-only C++ locals and parameters, collection elements containing them, consuming owned enum matches, cleanup-free direct-awaited output, and fallible native result transfer through `try`/`attempt`/match across suspension. Values declared directly in `async scope` have live-state cleanup after child join across normal exit, `break`/`continue`, return, throw, and cancellation; cleanup-bearing ordinary conditional/loop/match locals remain |
| Executor | Implemented serial/thread-affine tier | Deterministic FIFO per executor: root/main work uses its serial executor and an explicitly async `thread.spawn` closure owns a private executor bound to that OS thread; shared pools and work stealing remain planned |
| Explicit native threads | Implemented thread-affine tier | `thread.spawn` starts one OS thread for a synchronous or explicitly `async` one-shot closure; an async worker owns a private executor, can await scheduler operations and structured children, can `await on thread.main`, and resumes on the same live worker; `move` is required when capturing; plain values copy, unique Array/String/TextBuffer owners and explicitly contracted C/C++ native owners move, deeply readonly classes share through atomic ARC, and main-isolated Z classes cross opaquely with access and release confined to main; `(): T throws E` produces `Task<T, E>` with live-state-aware owned errors plus bound/direct `try` and local `attempt`; await, cooperative cancellation, and implicit scope exit suspend through race-free cross-executor queues before joining; native `share` remains deferred |
| Callable executor contracts | Implemented synchronous tier plus expanding stored-async task tier | Function types and free functions may declare `on thread.any`; function types may also preserve `on thread.main`. Neither contract schedules work by itself. Arbitrary-thread callables use atomic captured environments and require a recursively shareable graph. Main callables require main proof for construction and invocation, propagate lifecycle affinity through aggregate fields and their defaults, accept main-isolated captures, and cannot be weakened to an executor-local type or transferred to a worker. A `thread.any` callable may satisfy local or main storage. Stage 0 and the fixed-point native frontend preserve the same type identity, field affinity, named synchronous conversion, contextual closure proof, callable-field C lowering, and typed `Result<T, E>` propagation. Function types may now begin with `async`; a contextually typed captured async closure is stored without starting work and direct `await handler(in value)` starts and joins a dynamic child frame through a typed start-frame ABI. Stage 0 also executes `task handler(...)` as a hot structured `Task<T, E>` with typed `try`/`attempt`, consuming cancellation, explicit join, lexical implicit join, ARC capture lifetime, and exact child/context destruction. Borrowed task arguments require named address-stable storage within an explicit `async scope`. Native lowering preserves asynchronous function-type identity through aggregate storage and emits the distinct `start(context, executor, ...) -> Z_AsyncInvocation` C layout. Its executable tier covers nonthrowing expression closures: direct await starts a heap-owned frame, retains the captured environment for that invocation, transfers primitive or ownership-bearing results exactly once, destroys any unclaimed result with the frame, and releases the invocation context under strict C compilation. Completed closures finish immediately; a void closure whose body is one direct `await scheduler.yield()` polls and requeues on a local FIFO executor. The first linear `async main` shape is stackless end to end: its heap-owned parent frame stores the callable, one ordinary local, and the child invocation; passes a cleanup-free local by value or an ownership-bearing local through an address-stable `in` borrow; installs itself as the child's waiter; resumes only after child completion; and then reuses the local before deterministic cleanup. Live state makes normal completion and unfinished-frame destruction clean an owned local exactly once. Frame-level cancellation propagates from parent to child, uses the ordinary waiter wake-up, and deterministically unwinds the child invocation and live owners before marking the parent cancelled. The fixed-point emitter additionally executes one public callable-backed `Task<void>` inside an unnamed `async scope`, including an explicit consuming join or cancellation join and one optional borrowed owner. Typed callable task results/errors, implicit scope-exit join, general enclosing-function shapes, multiple children/locals/arguments, and named scopes remain next. Named async-function conversion, native-placement `attempt` payloads, async methods as values, broader owned captures, and weak captures remain deferred. |
| Structured scopes | Implemented slice | Lexical child joins, sibling/descendant cancellation, shared immutable and exclusive mutable child borrows, plus named `async scope updates {}` handles. A child site may not cross a loop back-edge while frames use one fixed slot per syntactic site; direct await or an async scope created inside each iteration provides a proven join. Imported `TaskScope` accepts thread-safe callback submissions onto `thread.main`, rejects during close, and joins accepted synchronous `(): void` or explicitly async `async (): void` roots and their descendants. `schedule` returns a cleanup-bearing, non-joining `TaskControl` with `accepted`, `requestCancel()`, and `isCancellationRequested`; scheduled async roots handle errors locally |
| Caller cancellation | Implemented slice | Consuming `await task.cancel()` requests cancellation, joins descendants and cleanup, and discards an unclaimed completed outcome |
| Timers | Implemented slice | Scheduler-aware monotonic `delay`; blocking `sleep` remains synchronous |
| Cooperative scheduling | Implemented | `await scheduler.yield()` requeues the current task on its existing executor without a timer or executor hop and exposes a structural cancellation-observation point |
| Sync work in async frames | Partial | Z and supported direct native calls/methods, console, checked arithmetic, `cstring` locals/calls, concise and block-arm matches, synchronous nonescaping inline closures with case-local environments, and receiver-tied views whose last use ends before suspension |
| Embedded awaits | Partial | Left-to-right cleanup-free values, awaited conditions, selected match/if/ternary/logical branches, and nested lazy boolean conditions; arbitrary lazy-expression embedding inside larger calls/aggregates remains |
| Lazy/suspending expressions | Implemented direct-value tier | `&&`, `||`, ternaries, value `if`, and value `match` preserve selected-branch evaluation in async binding, return, and control-condition positions. Selected results transfer scalar, ARC, String, Z-owned, or move-only native values; typed propagation and cancellation retain exact cleanup |
| Executor placement and isolation | Implemented ownership-aware native-aware tier | `thread.main` is typed; hop-and-wait, nested suspension, direct placed calls, and structured children execute through main placement. Block captures use contextual `using (in value, inout state, move owner)`; cleanup-free Copy values and String snapshots may remain inferred, loans last through join, borrowed children require an async scope, and `out` remains deferred. Async direct callees flatten to their original task frame; synchronous nonthrowing calls use a one-shot placed frame. Existing proof comes from declaration contracts or enclosing placement, so the redundant bare synchronous proof block was removed. Z `class`, `struct`, and `function` declarations accept a header `on thread.main` contract, and stored fields accept `field: Type on thread.main`. A selected field makes lifecycle main-bound while unrelated readonly thread-safe fields and unrestricted methods of a mixed ARC class remain usable on workers; unsafe fields are conservatively main-only and unrestricted methods cannot escape bare `this`. Whole-class isolation remains opaque off-main. A stored Z ARC class reference is now treated as a transportable executor-routed handle rather than inline isolated storage: a containing value aggregate may be constructed, returned, and cleaned up off-main, while access to the referenced class still enforces every field and method contract. Direct native and value storage continues to propagate affinity transitively. Explicit Clang actor attributes, declared Swift-target symbol graphs, and `.zd` native type/function/method fallbacks enter the same FIIR affinity fact. Stage 0 and native sema enforce off-main field, method, and function rejection; placed bodies and `Mutex.withLock` closures inherit the active proof, and construction plus weak-reference operations consult lifecycle affinity. Hover exposes access, lifecycle placement, and transportable ARC handles. Values/errors return to the original executor and cancellation routes to the child-owning executor; Darwin installs and wakes a CFRunLoop source. Throwing synchronous direct calls, aggregate worker capture containing executor-routed handles, raw foreign-identity transport, async isolated auto-hop, external prebuilt Swift module metadata, Windows message-loop integration, and Linux toolkit adapters remain |
| Channels and actors | Planned direction | API, isolation, and sendability remain intentionally unsettled |
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

## Agreed foundation sequence

1. **Optional receiver- and parameter-tied views — implemented.** Validate
   `Option<view T>` lookup results, multi-owner input provenance, match-arm
   provenance, last-use diagnostics, editor information, and one-pointer native
   lowering in application-shaped code.
2. **Move-only storage contexts — synchronous slice implemented.** Dynamic
   arrays use raw native storage, move construction during growth, and reverse
   destruction. Named enums manage the active tagged-union payload across moves
   and replacement. Compiler `Option` and `Result` use the same non-trivial
   tagged-union lifetime machinery, and all compose with Z-managed cleanup. Direct
   move-only C++ async locals, whole Z value structs/enums containing them, and
   fallible returns work across suspension, `return await`, `try await`,
   `attempt await`, hidden result slots, match, and cancellation. Owned async
   parameters transfer into child frames at task creation. Immutable `in`
   parameters work through direct await and explicit-scope task. Mutable
   `inout` parameters work through direct await and exclusive explicit-scope
   task. Fixed and growable async collection owners, including move-only native
   elements, now provide Slice backing with reverse cleanup on completion and
   cancellation; a live child-task loan prevents reallocation until join. Cleanup-free
   `out` works through direct await. Child-task output,
   ownership-bearing output, ARC fields, and closure environments remain.
3. **Larger application probe — implemented.** The multi-module
   `document-workspace` combines a move-only native lease, dynamic arrays,
   named enum transfer, cleanup-bearing errors, `try`/`attempt`, mutable methods,
   and `Option<view T>`, then verifies zero live native resources. It exposed and
   closed module-linked enum classification, view-method dispatch, and
   statement-valued `throw` lowering gaps.
4. **Self-hosting prerequisites — lexer and declaration-parser foundations implemented.**
   Target-neutral `std/fs`, `std/process`, and owned program-argument APIs run on
   macOS and have Windows/POSIX native branches. Checked String byte operations
   and `std/text` `TextBuffer` now support a multi-module Z source inspector with
   UTF-8 boundary-preserving token copies, escape decoding, source locations,
   typed lexer errors, exact current keyword/operator kinds, decimal/exponent
   numbers, template interpolation modes, line and non-nesting block-comment
   trivia, and unknown-byte rejection. Native scanning and slicing retain UTF-8
   byte indexes while public offsets and columns use the shared UTF-16 code-unit
   contract required by stage 0 and LSP clients. Stage 0 compiles a native
   token-stream bridge and compares its kinds, decoded text, offsets, lines, and
   columns with the TypeScript lexer through `z self-host-lex`; the Z lexer also
   tokenizes its own complete source. The bridge buffers its full protocol into
   one native write.
   A linear Z parser now consumes the native token array and retains an owned,
   source-located top-level declaration skeleton for imports, functions, structs,
   classes, traits, transparent type aliases, and enums. `z self-host-parse` checks exact declaration kind,
   name, export/async state, order, and location parity against stage 0 across an
   adversarial fixture plus the lexer and parser sources themselves. Complete
   import nodes retain default namespace bindings or selective imported/local
   names, alias source locations, and module headers with exact parity, providing
   the first structural input for a native module resolver. Complete top-level
   function signatures retain generics and constraints, receiver and
   parameter capabilities, nested canonical types, return types, and `throws`.
   Structs/classes now retain generic constraints, implemented traits, visible
   and readonly fields, throwing constructors, static/async/receiver methods,
   and `deinit`; trait methods, alias targets, and enum payload variants are structural too.
   Canonical type-shape parity covers the complete declaration layer. Top-level
   function bodies now retain owned `const`/`let`, `return`, expression-statement,
   and recursively nested block nodes. Primary and postfix expressions are now
   real flat arenas covering identifiers, scalar literals, parentheses, arrays,
   objects, calls, member access, and indexes. Prefix unary operators, the full
   current binary-precedence table, and right-nested ternaries use the same
   representation. `new`, `weak`, `try`, `attempt`, direct `await`, and direct
   `task` retain their distinct grammar and node kinds too. Nodes retain values,
   integer child edges, argument/field labels, and locations without recursive
   heap boxes. Enum payload construction retains separate enum/case/payload
   identities, and explicit `out`/`inout` call arguments retain their capability
   and source-located binding as first-class nodes. Generic identifier and member
   callees retain canonical nested type arguments, making the parser's pervasive
   `Array<T>()` arena construction structural rather than opaque.
   Unsupported expressions remain source-located canonical token spans marked
   opaque; unsupported statement forms remain traversable but unmaterialized.
   Exact body parity now covers the fixture plus the lexer and parser sources
   themselves. Traversal borrows tokens and copies only AST-retained text. Parser
   framing is shared by executable and library clients. The compiler-facing
   parser bridge is content-addressed by its compiler/frontend inputs, loaded
   once as a native dynamic library, and receives each file's path and source
   bytes synchronously through Bun FFI. It therefore avoids both helper-process
   startup and native-side file I/O. `z self-host-parse ... --timings` exposes
   library preparation, in-process native frontend work, protocol decoding, and
   the stage-0 parity parse independently. This pressure also closed canonical
   `TextBuffer`/`Arena` type identity through intermediate source modules.
   Native `Arena` lowering now goes beyond that identity proof: direct and
   aliased construction, stable pages, cleanup-free and cleanup-bearing
   `create`, reverse cleanup, reset reuse, and scope cleanup execute through the
   fixed-point C emitter. Source Inspector's Arena pressure path runs the
   production lexer over its own source and batches temporary token-coordinate
   records without per-record destructor metadata. The first stored-provenance
   slice now permits one-owner value structs to retain those record views and
   move into the same Arena. Populated Arrays can now consume several such
   structs, prove one shared owner, and move their growable buffer into that
   Arena. Empty mutable Arrays can now establish the same identity directly or
   across exhaustive branches whose continuing paths agree, enforce it on later
   pushes, and reject reallocation while an element view is live. Enums can now
   consume a one-owner value-struct payload, represent ownerless alternatives
   without a runtime tag, nest through another value struct, move into a
   compatible Arena, and expose the active payload through a borrowed match.
   `if` and `match` joins retain one possible owner and reject disagreement.
   Value structs can now add a nullable recursive edge with
   `Option<view T>`; `none` stays ownerless, `some` retains its Arena proof, and
   both frontends niche-lower the edge to one pointer. The production parser
   now moves its completed `Array<ParsedModule>` into one Arena and returns a
   `ParsedModuleBatch` whose module view is borrowed through resolution and C
   emission. Individual AST allocations remain ordinarily owned; broader
   multi-edge graphs, loop-carried identity, and direct region allocation of
   the complete parser AST still require richer provenance evidence.
   The reusable lexer, parser, protocol, and in-process library now live under
   `compiler/frontend`; Source Inspector remains their readable application
   client and standalone bridge pressure test. The first native module resolver
   directly consumes parsed Z `Program` values from a host-loaded canonical
   source batch. It validates lexical `./`/`../` edges, dependency-first order,
   selective exports and aliases, duplicate bindings, missing modules, and
   cycles without serializing the AST between parsing and resolution. That batch
   now crosses the compiler's existing in-process native-library boundary in one
   FFI call. `z self-host-resolve` compares module indexes, lexical edges, entry,
   and dependency order with a stage-zero graph and reports boundary, framing,
   native execution, decoding, and stage-zero parity timings separately. The
   stage-zero linker and native boundary now consume one canonical source batch;
   the command discovers its full local graph from only the entry path. The first
   native semantic tier builds and parity-checks source-located symbols for Z
   functions, structs, classes, traits, enums, namespace imports, selective
   bindings, aliases, exports, and local target modules. Function symbols also
   retain async state, generic parameters, parameter capabilities and types,
   return type, and error type through the native graph protocol; aggregate type
   signatures also carry custom-deinitializer/custom-constructor state and the
   constructor's parameter/result/error contract. A first native lexical resolver
   now walks every materialized function, constructor, method, and `deinit`
   expression tree in source order. It introduces parameter and local bindings,
   isolates nested blocks and loop bindings, adds closure parameters and
   match-arm payload/destructuring bindings, recognizes `this` only in instance
   bodies, and reports unknown names at their native source coordinates.
   Native type-name lookup now retains every nested nominal component directly
   in `TypeReference` rather than reparsing its canonical display string. It
   resolves primitives and standard type constructors, generic parameters,
   local/imported declarations, local namespace exports, fields, constraints,
   parameters/results/errors, enum payloads, local annotations,
   closure/executor signatures, `new`, and explicit generic arguments. Unknown
   nested types report the exact inner token location. Z and intrinsic generic
   type uses now validate arity and nominal constraints recursively, including
   nested generics and function signatures, while preserving bare generic names
   at constructor-inference sites. Opaque expression spans, foreign namespace
   member verification, value member lookup, duplicate local diagnostics, full
   type compatibility/conformance, and complete ownership coverage remain
   stage-zero work.
   The first native expression-typing tier now carries declared parameter types
   into source-ordered scopes; infers scalar, template, fixed-array, identifier,
   and explicitly typed closure values; and propagates direct Z call results. It
   validates known local initializers, assignments, boolean
   conditions, call arguments, return values, unary/binary operators, indexing,
   and ternaries. Direct calls now follow local declarations, selective imports
   (including aliases), and namespace imports to their target signatures.
   Generic calls infer type parameters through direct, nested generic,
   fixed-array, `Slice`, nullable, and `view` parameter shapes, or accept
   explicit type arguments, before substituting parameter and result types.
   Argument-driven inference now also specializes local or imported generic
   struct literals, synthesized class initialization, and declared class
   constructors; selective aliases preserve caller-visible result spellings
   while evidence remains keyed to the defining type. Context-only aggregate
   inference for parameters absent from every field/constructor argument remains
   unresolved in the native tier.
   Conflicting inference, value/type arity, and known cross-module argument
   mismatches originate in Z.
   Local and imported enums plus compiler-provided `Option<T>` and `Result<T, E>`
   now drive native match subject and payload types. Type symbols carry aggregate
   type parameters, field contracts, visibility/read-only state, and enum
   variants/payloads across the native graph protocol. The pass validates unknown
   and duplicate variants, payload/payloadless patterns, local or imported generic
   aggregate destructuring fields, exhaustiveness, and known expression-arm result
   types. Unknown foreign and async shapes remain explicitly unresolved,
   so this tier increases guarantees without emitting speculative errors.
   Z-defined field reads and assignments now resolve across local, selective,
   and namespace type names, substitute generic field types, enforce private and
   read-only contracts, and make enum comparisons concrete. Foreign, intrinsic,
   and extracted method values still defer. Z-defined instance and static calls
   now follow
   local/imported type metadata, enforce visibility and argument/result contracts,
   and substitute aggregate and method generics. Receiver capability state
   participates in the first native ownership pass. Nominal identity now uses
   defining module/symbol coordinates independently of whether source spells a
   type locally, through a namespace, or through a selective alias. Imported
   function/method signatures, fields, and enum payloads rebase into the caller's
   visible spelling, including transit through an intermediate module. Generic
   inference compares those identities recursively through nullable,
   `view`, fixed-array, and nested-generic shapes while retaining readable source
   spellings in genuine conflict diagnostics. Native bindings now retain the
   first capability-state bit: direct reassignment accepts `let`, `inout`, and
   `out` storage while rejecting `const`, value, and `in` bindings. Bindings also
   carry initialized, uninitialized, or maybe-uninitialized state. Direct
   assignments and nested blocks update it, `if` merges only continuing branches,
   loops retain the conservative zero-iteration path, and successful returns/fallthrough
   require every `out` parameter to be initialized. Direct/imported function and
   Z-method calls now enforce `out`/`inout` markers, mutable storage, initialized
   `inout` input, invalid explicit capabilities on value/`in` parameters, and
   parameter types before a successful `out` transition initializes storage.
   Expression traversal carries effects left-to-right; ternary and short-circuit
   alternatives merge them conservatively. Per-call access roots now reject all
   overlaps except `in`/`in` and `value`/`value`, including receiver/argument
   conflicts. Value-struct `inout this` requires mutable addressable storage;
   owned `const` class references retain identity mutation while immutable `in`
   class borrows reject it, and borrowed `this` cannot invoke `move this`.
   Bindings now additionally carry available, moved, or maybe-moved state.
   Cleanup-bearing values passed to owned parameters transfer ownership while
   ARC classes, weak references, and function values copy; continuing branches
   and loops merge state conservatively while exiting branches are excluded,
   borrowed bindings cannot be consumed, assignment
   and successful `out` restore storage, and `move this` invalidates a named
   receiver. A consuming value-struct method may transfer its sole
   ownership-bearing field while invalidating the whole receiver; custom
   `deinit` and any second cleanup-bearing field preserve the general
   partial-move rejection. Exhaustive `match (value)` consumes cleanup-bearing subjects while
   `match (in value)` borrows named storage; payload bindings inherit the matching
   access, cleanup-bearing destructured fields remain borrowed, and continuing
   arms merge outer move state. Readonly-field receiver paths, richer reachability,
   and nested value mutation remain part of the broader native ownership/flow pass.
   Local initialization, whole-value replacement, return, throw, selected match
   results, conditional branches, fixed-array elements, synthesized aggregate
   fields, and enum payloads now share the same ownership-transfer primitive.
   Synthesized object construction validates complete field shape and recursively
   consumes ownership only when graph metadata rules out a custom constructor.
   Declared class construction uses its graph-carried parameter capabilities and
   types, substitutes aggregate generics, and shares the ordinary call transition
   rules for owned, `in`, `inout`, and `out` arguments. Synchronous Z functions,
   methods, and constructors retain a pending error effect until `attempt`
   produces `Result<T, E>` or `try` validates compatible propagation from an
   enclosing throwing body. Unhandled calls, non-throwing wrapper operands,
   incompatible errors, and invalid `throw` statements diagnose natively, with
   generic substitution and imported aliases preserved.
   Local closure expressions now retain callable parameter modes/types and
   inferred or explicit result contracts, analyze expression and block bodies in
   nested value environments, and invoke through the same argument capability,
   exclusivity, transfer, and type rules as named functions. Native capture
   discovery excludes parameters and closure-local bindings. Borrow closures
   conservatively loan cleanup-bearing outer values; `move` closures consume
   unique owners while ARC identities remain copyable. Immutable capture writes,
   use-after-capture moves, uninitialized captures, and moved captures diagnose
   in Z.
   Enclosing return contracts now flow through statement match arms, and
   payload-free enum/`Option` constructors no longer resemble partial field
   moves to ownership analysis. The resolver now uses its own owned `Set<String>`
   for binding membership and `Map<String, usize>` indexes for symbol lookup;
   copyable `Option<view usize>` payloads load into independent indexes while
   cleanup-bearing views remain borrowed. With explicit copies on alternate
   owned-String result paths, the native resolver analyzes the complete
   three-module frontend graph—lexer, parser, and resolver—with 375 symbols and
   exact stage-zero graph/symbol parity.
   Ordinary `z check` can now opt into that same result through
   `--native-frontend`; stage zero remains authoritative for diagnostics, then
   native analysis gates success on exact parity. This is now a narrow hybrid
   integration, not yet a frontend-selection promise. It exposes equivalent-work timings and
   lets application checks grow the native corpus without changing default
   diagnostics. The ordinary analyzer now supplies its already-discovered
   canonical `SourceModuleBatch` to a resolver callback after successful stage-0
   semantics, validates module identity on return, and retains the resulting
   native graph on `AnalyzedSource`. `NativeSemanticIndex` is the first
   compiler-owned consumer: it resolves local symbols, selective aliases, and
   namespace members to their defining native declaration and callable/type
   signature. A compiler parity service now constructs the canonical stage-zero
   graph and proves each indexed binding lookup plus resolved selective/namespace
   signature against it; both `check --native-frontend` and
   `self-host-resolve` use that one service. Native evidence is prepared before
   the main stage-zero semantic pass, allowing successful direct Z function,
   static-method, instance-method, and explicit class-constructor calls to
   shadow-resolve their defining native symbol and signature as they occur.
   Method observations additionally prove static/instance identity, visibility,
   receiver capability, async/error state, parameter capabilities and types, and
   result type. Constructor observations prove the corresponding parameter,
   result, and error contract. The check report keeps function, method, and
   constructor resolution counts separate so this live migration surface remains
   measurable instead of disappearing inside whole-graph parity.
   Struct and synthesized-class aggregate construction, every Z field selected by
   construction or member access, and payload-bearing or payload-free source enum
   variants are now native-authoritative. Aggregate
   contracts supply struct/class identity and field layout while preserving the
   validated stage-zero constructor/deinitializer bodies needed by lowering;
   field contracts supply source type, visibility, and readonly state; enum
   contracts supply exact payload type. The resolved field selected during a
   member expression is retained for later assignment and mutable-method checks,
   so native readonly metadata feeds the existing ownership path rather than a
   parallel checker. Match statements and expressions use native variants, and
   object patterns use the same native field contract for binding types and
   ownership. Separate aggregate, field, and enum-variant authority counts keep
   this migration tier measurable. Generic aggregate construction and field
   resolution use the native template's structural metadata while retaining the
   linked concrete declaration as lowering identity; the bridge keys that rebase
   by source definition and field name and never decodes a monomorph name.
   Explicit local,
   closure, and executor-placement type uses now recursively rebuild Z types from
   native declarations nested in function values, `Weak`, `Task`, `Option`,
   arrays, slices, and views. The rebuilt names feed local storage, closure
   signatures, and executor result/error contracts. Explicit uses of linked
   generic aggregate types now follow that same validated template-to-concrete
   rebase. Native checks report these type-use authority resolutions
   independently, while primitive, foreign, compiler-synthesized, and bare
   generic-parameter types remain on the stage-zero path.
   The graph protocol now also exports source-located concrete generic-call
   contracts after native inference settles. Each record identifies its defining
   module and symbol and carries type substitutions, parameter capabilities and
   types, async/error state, and result type. `NativeSemanticIndex` validates and
   indexes these records by canonical module plus call-expression offset. Direct
   generic Z functions are native-authoritative when the complete contract maps
   cleanly onto the linked concrete declaration. Source-template substitution
   proves nested concrete contracts such as `Option<i32>` before rebasing them
   onto Stage 0's temporary materialized lowering names. Direct calls now infer missing
   generic result parameters from local annotations, assignment targets, and
   enclosing function returns before exporting the same concrete evidence.
   Generic functions, static and instance methods, declared constructors, and
   synthesized aggregate fields propagate settled contracts through nested calls
   and ternary, value-producing `if`, and expression-`match` branches. Concrete
   names needing richer cross-module rebasing retain the stage-zero fallback. The same source-keyed evidence now makes instance/static methods on
   generic owners and inferred or explicit generic-class constructors
   authoritative after validating the owner symbol, ordered substitutions,
   receiver contract, and fully concrete callable signature. Native checks report exported contracts
   separately from contracts actually consumed by the semantic bridge.
   Unannotated initialized `const` and `let` declarations now export a second
   source-located evidence stream containing the native frontend's settled local
   type. The compiler indexes those records by binding-name offset and validates
   name, mutability, and source-level type before using them as authoritative
   local binding contracts. This includes materialized generic values such as
   `Option<i32>` through the compiler's source display-name map. Direct aggregate
   bindings also carry their resolved module and symbol, allowing local,
   selective-import, and namespace-qualified spellings to prove the same type
   identity without string heuristics. Path-keyed identities now recurse through
   compiler-known wrappers including `Option`, arrays and slices, views, `Weak`,
   tasks, function signatures, and materialized `Result` payloads. User-defined
   generic aggregate materialization retains its source template and ordered
   source arguments, so nominal identities survive nested monomorphs such as
   `Envelope<Slot<SyntaxNode>>`. The bridge validates those identities at their
   exact generic paths and no longer lets equal-looking type text bypass nominal
   proof.
   Settled root expressions now export their own source-located evidence stream.
   Each record carries the inferred source type plus recursive nominal identity
   paths, and `NativeSemanticIndex` keys it by canonical module and expression
   offset. The semantic bridge accepts a native expression result only when its
   location, concrete type, and every declaration identity match the linked
   Stage-0 expression. Generated, opaque, foreign, unsupported executor,
   and otherwise absent roots continue through the Stage-0 fallback. Ordinary native checks report
   expression contracts exported, observed, and used authoritatively as separate
   counts.
   Native evidence lookups translate linked Stage-0 source locations back to
   canonical module-local offsets before querying the semantic index. Imported
   function bodies therefore no longer miss evidence—or collide with unrelated
   local offsets—after Stage 0 rebases them into one linked program. Qualified
   type names rooted in non-Z selective imports are treated as opaque foreign
   types, so application-shaped C++ resources compose with native Z analysis
   without the resolver pretending to understand the header.
   A representative ordinary-check corpus now covers the six-module native
   frontend itself, Source Inspector, Document Workspace, `Result`, arenas,
   owned closures, generic constraints, and async ownership. On that corpus,
   every function/method/constructor, aggregate/field/variant, explicit type,
   inferred binding, and root-expression resolution observed by Stage 0 is
   backed by a consumed native-authority contract.
   Successful non-generic Z function, method, and explicit class-constructor calls
   are now native-authoritative semantic results. Their parameter modes and types,
   async/error state, and result type come from the native signature; methods also
   take static/instance identity, visibility, and receiver capability from native
   metadata. A checked rebasing step maps native source-level type names onto the
   already-linked stage-zero declarations used by ownership analysis and code
   generation, so native `inout this` and `move this` feed the existing
   exclusivity and consumption checks rather than creating a parallel ownership
   path. Stage zero independently proves each contract equivalent before using
   it. Direct generic functions, methods on generic owners, separately generic
   instance methods, separately generic static methods on non-generic owners,
   and inferred or explicit generic-class constructors with complete native
   substitutions now use the same authority path. The fixed-point emitter also
   demand-specializes generic free functions across module aliases, recursively
   propagating dependent generic-to-generic calls. Static calls combining an
   independently generic owner and method remain deferred pending syntax. Ordinary
   checks without `--native-frontend` retain the stage-zero path.
   Native-authority counts are reported separately for functions, methods, and
   constructors.
   Direct Z async calls now retain an internal pending success/error effect
   instead of discarding their result type. `await` consumes that effect only
   inside an async function, preserves typed failures for the surrounding
   `attempt` or `try`, and rejects unsettled async calls. Cold
   `AsyncGenerator<T, R, E>` construction remains synchronous, while intrinsic
   awaited `.next()` advancement follows the same pending-effect path. The
   existing async-generator and scalar async-error examples now export and
   consume every inferred binding contract through native authority.
   Structured `task operation()` now converts the same pending call effect into
   source-level `Task<T>` or `Task<T, E>` evidence. Awaiting a named handle
   consumes its ownership and restores the success/error effect for direct,
   `try`, or `attempt` handling. The existing async-tasks application moves from
   four to all twelve inferred bindings under native authority.
   Native-source-resolved `await on` and `task on` placements now preserve
   direct call effects and block result/error contracts. Explicit `in`, `inout`,
   and `move` captures are validated in a dedicated semantic module; block
   `select` types and post-join ownership flow feed ordinary native evidence.
   The executor-placement example moves from two to all six inferred bindings.
   A placement whose capture originates in unavailable foreign or
   `thread.spawn` metadata deliberately defers instead of inventing an
   unknown-capture diagnostic.
   A wider executable-corpus sweep now also guards semantic compatibility at
   the native boundary. Trait method signatures preserve `inout this` and
   `move this`; contextual payload-free generic variants such as
   `Option.none` are constructors rather than ownership-bearing field moves;
   and function values compare by capabilities and parameter/result types
   rather than local parameter names. Function-valued aggregate fields are
   callable through the same native signature path. The existing classes,
   Option, owned async-enum, and function-value programs all pass with every
   Stage-0-observed binding and expression backed by native authority.
   Transparent callable aliases now expand to their underlying signature during
   native closure contextualization and calls. Function-type parsing retains
   `throws E`; contextual and explicitly throwing closures carry that error
   into body checking, returned function evidence, and pending call effects.
   The ordinary throwing-function application plus both native-thread error
   examples now consume every observed binding and expression through native
   authority.
   Compiler-provided weak references now cross the same boundary:
   `WeakExpired` is an intrinsic type, `weak value` requires a Z class without
   consuming its strong owner, and `Weak<T>.upgrade()` produces a native
   throwing effect returning `T`. The existing weak-reference and weak-capture
   application now consumes all ten observed bindings and all twenty-seven
   observed expressions through native authority.
   Fixed-point C emission now materializes the same zeroing-control model for
   ordinary and demand-specialized generic ARC classes. Executable fixtures
   prove copied weak-handle retention, clearing before class `deinit`, strong
   retention on successful upgrade, `WeakExpired` after owner replacement,
   `try`/`attempt`, canonical generic identity across selective module imports,
   and a complete class-to-owned-closure-to-weak-class cycle. Function-valued
   field reads retain their closure environment, class cleanup releases its
   stored handle, and an independently retained handler observes expiration
   after the class owner is destroyed. Callable layouts now precede aggregates
   that store them while helpers follow complete payload types, and canonical
   synchronization/task identities remain resolvable across compiler helper and
   module boundaries. Concurrent upgrade remains intentionally outside this
   single-executor tier.
   Recursive cleanup and explicit-copy analysis now remain in an aggregate's
   defining module. Only concrete generic arguments are rebased into that
   module before substitution, so an exported struct cannot lose ownership
   merely because one of its nested field types is not separately imported by
   the caller. The unchanged project-index application now consumes all seven
   observed bindings and all twenty-four observed expressions through native
   authority, including its explicit move of an `IndexReport` whose nested
   `FileRecord` owns Strings.
   Dependent relational comparisons in generic bodies now accept a contextual
   numeric literal provisionally when the other operand is an active type
   parameter. This mirrors Z's existing template-style behavior for the
   concrete `Pair<i32>` specialization and restores native authority for all
   five calls, four inferred bindings, and six observed expressions in the
   existing generics example. Stage 0 still proves each concrete
   specialization; native specialization must replace this narrow deferral
   before Stage 1 can become the sole authority for unconstrained generic
   operators.
   A 155-root executable-example sweep found five false native diagnostics where
   the source-only graph lacked Clang/Objective-C metadata: numeric C typedef
   operations, contextual foreign literals, copied foreign property results,
   and contextual block closures. Imports with no local Z module target are now
   explicitly classified as unresolved external types. Only judgments that need
   the missing ABI facts defer to Stage 0; surrounding Z calls, aggregates,
   bindings, expressions, and ownership remain native-authoritative. The five
   unchanged interop examples now check. The adjacent raw-native root exposed a
   parser rather than type-system gap. Stage 1 now lexes a raw body as one opaque
   token, preserving nested native braces/quotes/comments, and structurally
   accepts `function ... = raw c|cpp|objc { ... }` without interpreting the
   embedded source. Ordinary identifiers named `raw` remain ordinary. All 155
   executable examples now pass the hybrid gate with zero partial
   binding/expression-authority gaps; Stage 0 continues to own raw escape-hatch
   semantic validation.
   The first native C-emission proof now consumes the owned Stage 1 `Program`
   directly. `z self-host-emit` lowers a deliberately closed subset—ordinary
   `i32`/`boolean`/`void` functions, value parameters, explicitly typed locals,
   direct calls, unary/binary/ternary expressions, assignment, `if`, `while`,
   `break`/`continue`, returns, and non-generic data-only value structs—to
   portable C. Struct layout, compound construction, value passing, and field
   access are executable. Before emission, the canonical
   batch passes through the same native module resolver and semantic analyzer
   used by the parity bridge; an invalid name is rejected natively rather than
   left for Clang. Regressions compile and execute both a scalar call program
   returning 42 and a mutable factorial/control-flow program. Raw signed C
   arithmetic is not substituted for Z semantics: emitted `i32`
   addition, subtraction, multiplication, and negation use checked helpers, and
   an overflow regression terminates instead of invoking C signed-overflow
   behavior. This removes TypeScript AST reconstruction from one complete
   source-to-native path. It is not yet the production emitter: Stage 0 remains
   authoritative for the full language, module linking, ownership cleanup,
   runtime types, foreign interop, and production diagnostics.
   The scalar tier now emits `u8` and `usize` in addition to `i32`. Checked
   addition, subtraction, and multiplication use the semantic result type to
   choose width-correct overflow helpers, which is a prerequisite for native
   compiler arrays and source offsets rather than an unchecked C convenience.
   The first `Array<T>` lowering tier now emits monomorphized owned
   data/length/capacity storage in signatures and deterministic destruction.
   Cleanup-bearing elements are destroyed in reverse order before storage is
   freed. Empty construction, amortized `push`, `.length`, and bounds-checked
   indexing now execute for scalar and aggregate elements. Read-only
   `for...of` over stable Array storage and cleanup-free fixed-array storage is
   executable with borrowed and value element bindings respectively. Fixed
   arrays use their compile-time length and may nest recursively; mutable and
   object-pattern iteration remain fail-closed. With this
   tier present, the real compiler emission probe advances
   from `Array<Token>` to owned `String` as its first unsupported type. The
   following owned-String tier emits data/length/capacity storage, static UTF-8
   literals, exact byte equality, checked byte access, byte length/emptiness,
   owned UTF-8-boundary-checked `copyBytes`, and deterministic cleanup. It keeps
   cleanup-bearing `const` bindings writable at the C storage level solely so
   destruction can receive their address. The compiler probe now reaches
   explicit borrowed parameters as its next unsupported lowering contract. The
   following capability tier preserves `in`, `inout`, and `out` as
   `const T *`/`T *` C contracts, rewrites parameter reads and writes through
   those pointers, forwards addresses at calls, and never schedules borrowed
   values for owned cleanup. Its executable fixture covers borrowed String plus
   scalar initialization and mutation. The compiler probe now reaches inferred
   locals initialized by intrinsic String operations. Native semantic evidence
   now supplies the exact `byteAt`, `copyBytes`, `byteLength`, and `isEmpty`
   contracts, allowing inferred `u8`, owned `String`, `usize`, and `boolean`
   bindings to lower without a parallel emitter inference rule. Native
   `TextBuffer` now constructs empty owned storage, appends Strings,
   UTF-8-boundary-checked byte ranges, and ASCII bytes, and consumes that
   storage through `finish()` into a String without double cleanup. Templates
   now allocate one result and traverse typed parts directly rather than
   building chained String temporaries; String, boolean, `i32`, `u8`, and
   `usize` interpolation execute. The same runtime live flag used by
   conditional moves now safely covers moves inside loops, including
   reinitialization before a back edge. Generic intrinsic discovery resolves
   imported component types, allowing parser-side `Array<Token>` storage. The
   lowering graph also carries public value types that flow transitively through
   imported function results. Direct assignment-form `try` propagates failure
   and replaces scalar or cleanup-bearing storage only after success, while
   terminating match arms, explicit String `copy`, checked shifts, explicit
   `i32`/`u8`/`usize` construction, and wrapping add/subtract/multiply are
   executable. Checked narrowing traps, contained conversions compile to
   direct casts, and C-reserved Z binding names are escaped at emission.
   Native `Map<String, scalar>` lowering now emits an owned-key
   open-addressed table with `set`, `has`, `get`, and deterministic cleanup;
   its generated C fixture compiles and returns 42. The real compiler probe
   advances through both `Map<String, usize>` and `Set<String>`, then enters
   native lowering itself. Complete source-position identity now distinguishes
   nested expression evidence, match payload bindings export their inferred
   contracts, and uniquely named public field types can flow transitively
   without a redundant source import. Value-producing match arms can now
   propagate a direct throwing call through the existing typed `Result`
   representation. Checked integer division/remainder, ordinary imported-call
   contracts, discarded non-void `try`, nested assignment targets, and
   contextual `Option` returns now compose as well. Value-producing `match`
   lowering propagates that destination context into every arm, including
   payload-free `Option.none`, while owned contextual type-name storage is
   copied before consumed parser temporaries are destroyed. A fixed-point
   regression exercises this exact path through a rebuilt native compiler.
   The unchanged
   compiler graph lowers completely to a 2.3 MB C translation unit and that
   unit compiles and links under strict C11 with Clang
   `-Wall -Wextra -Werror`. Contextual `usize` arithmetic, deterministic
   borrowed String temporaries, nested mutable Array storage, collision-safe
   match payloads, and implicit successful `Result<void, E>` fallthrough were
   the final compile blockers. The compiler library still uses a bootstrap
   no-op `main`, while the standalone Z driver now compiles and executes with
   `process.args()`, typed `fs.readText()`/`fs.realPath()`, recursive canonical
   project discovery, and native `check`/`emit`/`build` commands. Project
   manifests, foreign discovery, full target configuration, `run`, and
   replacement of the production TypeScript-hosted driver remain.
   The flat typed arenas normalize checked arithmetic, direct calls,
   field reads, and struct construction before target emission; the C printer
   no longer imports parser nodes or interprets operator strings. Deterministic
   cleanup adds scope/branch/return exit plans, so ownership-bearing structs
   extend this IR rather than teaching the C printer source semantics.
   The first such extension is implemented for a deliberately linear tier:
   a data-only struct may declare an empty custom `deinit`, an owned value
   parameter receives an explicit lowered cleanup plan, and return emission
   saves the result before destroying the parameter. The executable regression
   places `Resource_deinit(&resource)` between result evaluation and the C
   return.
   A linear parameter-transfer follow-up lowers `move resource` explicitly.
   The relay function emits the value handoff without deinitializing it, while
   the final owner retains the return-exit cleanup.
   Top-level linear owned locals now enter that same cleanup plan after
   initialization. Live locals clean in reverse order after return-result
   evaluation, while `move local` transfers cleanup to the callee. Destructible
   value structs deliberately use writable C storage even when their Z binding
   is `const`: Z prevents rebinding semantically, while physical mutability lets
   `deinit` receive the value's address. A control-flow follow-up carries
   still-live outer parameters and locals through `if`/`while`; nested returns
   receive the current cleanup snapshot and fallthrough retains the owners.
   Cleanup-bearing locals within `if` branches now clean at branch fallthrough
   and before early return; a
   fallthrough analysis omits unreachable duplicate cleanup after a terminating
   block. Loop-local owners now clean at normal iteration fallthrough and on
   explicit `break`/`continue` edges. Cleanup tracking resets at the innermost
   loop boundary, preserving owners introduced by an outer iteration when an
   inner loop transfers control. Whole-binding replacement evaluates the new
   owner into a temporary, destroys the old value, and installs the temporary
   while retaining the binding's later exit cleanup. Cleanup classification now
   recurses through value-struct fields; generated outer deinitializers destroy
   cleanup-bearing fields in reverse order even when the outer struct has no
   custom `deinit`. Custom deinitializer bodies now lower ordinary synchronous
   statements, calls, and `this` field reads before the generated reverse-field
   epilogue. Their cleanup-bearing locals use the same arena-based lexical,
   loop-edge, replacement, and fallthrough planner as ordinary function bodies,
   and clean before stored receiver fields. Conditional transfer through `if`
   is executable for owned parameters and locals through generated live flags:
   `move` clears the flag before handoff and cleanup is guarded on every exit.
   Linear moves remain flag-free. Loop-carried transfer still rejects until its
   back-edge state can join; error cleanup merging remains a future slice.
   Payload-free nominal enums are now executable through this path as C enum
   tags, including case values, equality, parameters, returns, and storage in
   value structs. Cleanup-free scalar payload enums now lower to a tag plus
   payload union and support payload construction and return transport.
   Exhaustive statement match over identifier subjects emits a typed switch,
   binds scalar payloads, and carries arm returns/locals through cleanup
   planning. Cleanup-bearing payload enums now use dependency-ordered C
   definitions and synthesize an active-variant deinitializer. An enum may own
   a resource struct, a struct may own that enum, and reverse scope cleanup
   reaches the active payload exactly once even when source declarations are
   not dependency ordered. Consuming statement match now transfers an active
   cleanup-bearing payload into its arm binding, suppresses wrapper cleanup,
   and destroys the binding after result evaluation. Conditional consumption
   uses the same live-flag path as `move`, preserving wrapper cleanup only on
   the path that did not enter the match. A direct `return match (...)` with
   concise expression arms now normalizes to the same statement-match IR and
   cleanup plan, including owned payload transfer. General match-expression
   lowering now also initializes explicitly typed local bindings through
   exhaustive arm assignments. Cleanup-bearing arm values may transfer directly
   into either a return or the local result; scalar projections instead clean
   the payload at arm exit, and owned local results join ordinary reverse scope
   cleanup. Consuming constructor and call subjects now move into one typed
   temporary before dispatch, guaranteeing single evaluation while the selected
   payload becomes the arm owner. Borrowed matches remain tied to stored source
   storage. Selecting block arms now lower prefix statements plus their final
   `select` into the same result destination. Lexical owners created in the
   block clean before the selected payload owner on return or arm fallthrough.
   Compiler-provided `Option<T>` now reuses this enum machinery in the native
   emitter. Explicit `Option<T>.some(value)` and `Option<T>.none` lower to one
   monomorphized tag-plus-union value; parameters, returns, explicitly typed
   locals, direct-call subjects, and consuming matches are executable.
   Cleanup-bearing payloads synthesize an active-variant deinitializer and
   transfer into match bindings exactly once. The `Option<i32>` path adds no
   allocation, while `Option<Resource>` inherits the resource's deterministic
   cleanup. Compiler-provided `Result<T, E>` now shares that representation:
   `return` constructs `success`, `throw` constructs `failure`, and `attempt`
   preserves the tagged result for an exhaustive match. Both cleanup-free and
   cleanup-bearing success/error payloads are executable; an unconsumed result
   destroys only its active payload, while a consuming match transfers that
   payload to exactly one arm owner. Direct `return try call()` propagation
   relays an ABI-identical result after cleaning surrounding owners. An
   explicitly typed local initialized with `try` evaluates the call once,
   transfers success into the local, or constructs the enclosing failure after
   cleaning already-live owners. Nested expression propagation, inferred Option
   constructors, and inferred match-result bindings remain the next tiers.
   `Result<void, E>` uses a payload-free `success` case rather than emitting an
   invalid or placeholder C union field; `return;`, `throw`, `attempt`, match,
   and active error cleanup are executable through that representation.
   Procedural `try fallibleVoid();` emits the same single-evaluation failure
   branch, cleans surrounding owners before propagation, and continues without
   manufacturing a success value. Native lowering now consumes the resolver's
   authoritative inferred-binding evidence by source offset. Inferred scalar
   and struct locals, `Option`/`Result` storage, local `try` results, and scalar
   or owned match-expression destinations therefore retain the same settled
   type used by semantic checking and cleanup planning; the emitter does not
   maintain a second inference engine. The first multi-module emission tier is
   executable for dependency-ordered scalar modules: the canonical native graph
   drives lowering of every discovered module into one C translation unit, an
   imported function remains one direct call, a selective local alias resolves
   to its exported source symbol without a wrapper, and strict Clang execution
   returns the same result. A duplicate type or function spelling across
   modules is rejected before C emission. Imported aggregate identity, symbol
   identity is executable for value structs: a selective local type alias
   canonicalizes to the exported struct through factory return, inferred
   storage, local parameters, and field reads. Cleanup metadata crosses the same
   boundary, and an implicit owned-argument transfer destroys an imported
   cleanup-bearing value exactly once in its callee. Local wrappers containing
   imported owners now recursively inherit that cleanup and transfer it through
   field initialization and owned calls without double destruction. Imported
   enums preserve canonical identity, variants, payload types, and cleanup
   through selective aliases, direct construction, factory returns, exhaustive
   consuming match, and ordinary scope exit. Selectively aliased imported
   structs also support direct object construction while emitting the canonical
   target type. Colliding private functions, structs, and enums now receive
   module-qualified internal C identities. Local calls, type references,
   construction, enum payloads, match, and recursive cleanup follow the renamed
   symbols; colliding exports remain fail-closed until exported ABI naming is
   designed. Per-module translation units remain an explicit follow-up.
   Native resolver failures now cross the bootstrap boundary as structured kind,
   file, line, column, and message records. Unknown-name, unknown-type,
   unknown-member, type-mismatch, invalid-operator, and invalid-match failures
   become authoritative native diagnostics when their location belongs to the
   canonical source batch. Stage zero still owns parser, module-loading, and
   unsupported-shape diagnostics; malformed, out-of-batch, and non-semantic
   native failures remain buffered, so a Stage-0 error wins in those cases.
   Prepared-library invocation lives in a
   reusable native-frontend service rather than the CLI. Native checks therefore
   no longer repeat host import discovery or parity lexing/parsing—the comparison
   graph is built from the canonical batch's existing ASTs and dependency maps.
   The CLI now owns only native preparation/invocation and reporting, not graph or
   signature semantics. Later compiler consumers have an explicit migration seam
   instead of reading a CLI-only side effect.
   Native signatures now retain generic trait constraints and nominal aggregate
   conformance. Native inference enforces those constraints for inferred and
   explicit function/method calls and aggregate construction; constrained generic
   bodies may call only methods supplied by their declared traits. Unique
   factory-returned exported aggregate identities also retain nominal
   conformance without a redundant concrete-type import at the caller.
   Foreign method lookup, generic trait declarations, foreign call
   effects and executor placements with unavailable foreign/thread metadata,
   escaping closure-environment validation,
   precise closure borrow last-use release, remaining receiver-path capability
   enforcement, and full recursive ownership contexts remain stage-zero work.
   Template literals now
   retain ordered decoded-text leaves and ordinary embedded-expression roots,
   including nested templates, in the same flat arena. Expression-bodied
   closures retain borrow/move capture mode, source-located parameters,
   capabilities, optional parameter and result/error types, and an ordinary
   expression body root. Function, constructor, `deinit`, and closure bodies now
   use flat statement arenas with integer child edges. Block-bodied closures
   carry statement-root edges into the enclosing arena, so their currently
   supported variable, assignment, return, throw, select, expression, loop-control,
   and nested-block statements are structural without recursive per-block
   allocation. Assignments retain separate target and value expression roots,
   preserving Z's rule that assignment itself is not an expression.
   Structured `if`, `else if`, and `else` statements retain ordinary condition
   expression roots and integer branch edges. Explicit blocks and single-statement
   branches normalize to the same block node, while else-if chains point directly
   to the next conditional node.
   `while` statements retain an ordinary condition root and required block edge.
   `for...of` statements retain the immutable binding and its location, iterable
   expression root, and required block edge. Existing `break` and `continue`
   nodes therefore compose inside a complete structural loop tree.
   Value-producing `while` and `for...of` expressions retain the same condition,
   binding, iterable, and body edges plus a required exhaustion-value block.
   Their explicit `select` statements share the ordinary statement arena.
   Statement and expression `match` forms share a flat match-expression tree.
   Subject and arm edges, `in` mode, payload bindings, object-field destructuring,
   aliases, source locations, and each arm's statement body are structural.
   `async scope` statements retain their required block edge, preserving the
   lexical child-lifetime and implicit-join boundary for later native analysis.
   Value-producing `if` expressions retain condition, then-value-block, and
   else-value-block/if-expression edges. Their branch statements use the shared
   statement arena, preserving local declarations and explicit `select` nodes.
   Closures retain whether they are synchronous or `async`, including nested
   block-bodied worker closures. Executor-placement expressions retain
   await/task mode, a distinct source-located `on` marker, the executor
   expression root, optional success and error types, and either a placed body
   or direct placed call. This leaves a structural insertion point for the
   planned contextual `using` capture clause.
   Contextual keywords are accepted as member names after `.` just as they are
   by stage 0. Unicode identifiers remain future lexer work.
   Exact lexer and parser parity now covers UTF-16 locations after BMP and
   supplementary Unicode text without giving up byte-oriented native slicing.
5. **Threaded concurrency evidence — thread-affine async worker slice implemented.**
   `thread.spawn` now proves one real cross-thread task frame with explicit
   move capture, hot start, structured join, private Copy snapshots, and moved
   Array/String/TextBuffer owners/results, explicitly contracted C/C++ owners,
   plus atomic-ARC deeply readonly class identity, live-state-aware owned error
   transfer through `Task<T, E>`, and nonblocking executor completion.
   An `async` worker closure owns a private executor, awaits child work and
   delays, hops to `thread.main`, then resumes on the same dedicated worker;
   cooperative cancellation wakes and unwinds a suspended worker. The next
   concurrency probes should be driven by the desktop application: cross-thread
   callbacks, UI-thread delivery, weak-reference and destruction-affinity
   protocols, and mutable shared-state isolation. Do not commit actors,
   channels, pools, or a multithreaded executor as settled language design yet.

## Self-hosting continuation point

Self-hosting has advanced beyond its stable semantic-authority checkpoint into
the first executable native-emission slice, but is not declared complete.
Native Z owns lexing, structural parsing, module-graph resolution, a substantial
semantic subset, structured diagnostics for that subset, the evidence consumed
by ordinary `check --native-frontend` runs, and a deliberately narrow direct
AST-to-C proof. The representative corpus gate must remain green as this grows.
That positive gate is necessary but not sufficient: every lowering expansion
must also carry negative native/Stage-0 rejection parity for the ownership,
capability, sendability, and executor-affinity rules it depends on. The first
executor-affinity rejection suite now covers off-main field, method, and
function access plus valid inherited contexts; future lowering slices must keep
expanding both halves of that evidence.

Continue focused self-hosting work in this order:

1. Continue decomposing the former 8,980-line `module-resolver.zs` without
   changing semantics: separate evidence/model types, graph construction, name/type
   utilities, and expression/ownership flow behind one resolver operation and
   one explicit model module. Keep parity and timing gates green. Use the
   extraction to determine whether ordinary Z modules are sufficient or whether
   a narrowly scoped borrowed semantic context is justified; do not infer a
   need for trait values merely from the current file size. Evidence/model,
   lexical module paths, signature projection, and symbol construction are now
   separate. Parsing, dependency edges, graph skeleton construction, and
   dependency ordering now live in `module-graph.zs`; lexical scope and name
   validation now live in `semantic-names.zs`. Shared intrinsic, numeric,
   nullable, fixed-array, generic, and callable type-shape recognition now lives
   in `semantic-type-shapes.zs`. Canonical cross-module type identity, spelling
   rebasing, and trait lookup now live in
   `semantic-type-identities.zs`; declaration type-name, arity, callable-shape,
   and generic-constraint validation now live in
   `semantic-type-validation.zs`. Semantic orchestration, expression inference,
   and ownership diagnostics remain in the resolver. The initialization and
   ownership state values plus binding copy, mutation, borrow, and branch-merge
   operations now live in `semantic-flow-state.zs`. Generic substitution,
   cleanup detection, move-on-owned-use, explicit-copy eligibility, and custom
   constructor lookup now live in `semantic-type-ownership.zs`. Enum-match
   shapes, aggregate-field lookup, method signatures, generic constraint
   bindings, and owner visibility identities now live in
   `semantic-member-lookups.zs`. Match payload bindings, object-pattern shape
   validation, private-field enforcement, and pattern diagnostics now live in
   `semantic-pattern-validation.zs`; arm expression inference and ownership-flow
   merging remain in the resolver. Recursive generic unification, contextual
   substitution, constraint checking, and parameterized type-name construction
   now live in `semantic-generic-inference.zs`; aggregate construction consumes
   one normalized lookup shape while recursive field-expression inference
   remains in the resolver. Per-call capability conflicts and pending
   throwing-call effects now live in `semantic-call-contracts.zs`.
   Initialization/use-after-move diagnostics, storage-root discovery, and
   whole-value consumption now live in `semantic-expression-ownership.zs`.
   Expected/actual compatibility for callable values, contextual literals,
   nullability, Slices, and receiver-tied views now lives in
   `semantic-expression-types.zs`. Closure parameter contextualization,
   callable-shape construction, and lexical capture discovery now live in
   `semantic-closures.zs`; move/borrow effects and recursive closure-body
   inference remain in the resolver. Function parameter and receiver bindings,
   generic context, and generator yield/return discovery now live in
   `semantic-function-contexts.zs`; statement traversal and final output
   initialization proofs remain in the resolver. Compiler-provided numeric
   literal, collection method, iterable projection, and throwing-generator
   behavior now lives in `semantic-intrinsics.zs`. Callable target identity and
   construction/deduplication of generic-call, inferred-binding, and
   root-expression evidence now live in `semantic-evidence.zs`; recursive
   inference still decides what evidence is authoritative in the resolver.
   Copy/move eligibility plus unary, arithmetic, bitwise, comparison, and
   equality result typing now live in `semantic-operators.zs`; short-circuit
   flow and actual ownership consumption remain in the resolver.
2. Extend native semantics from demonstrated corpus gaps, prioritizing
   foreign/intrinsic boundaries, escaping closure environments, precise borrow
   last-use release, receiver-path capabilities, and recursive ownership
   contexts. Do not port a feature merely for nominal completeness; add a
   realistic corpus case first.
3. Keep the complete representation-neutral resolver stream green. It supplies
   entry, module paths, dependency lists/order, symbols, every signature shape,
   and all call/binding/expression evidence without exposing emitted C layout.
   Preserve generic constraints, fields, variants, trait conformance,
   capabilities, effects, source locations, flattened nominal-identity paths,
   canonical module-local locations, and the guarded Stage-0 fallback. Measure
   cold library preparation, warm native work/stream decoding, and Stage-0
   parity separately.
4. Finish the native semantic subset required to compile the compiler itself.
   Broader language features may continue to fall back to Stage 0 until their
   native representation is justified by real programs.
5. Grow the now-started native lowering and C-family emitter from its executable
   scalar, control-flow, value-struct, owned enum, and intrinsic `Option<T>`
   slices to the compiler subset. The explicit typed lowering IR and
   deterministic scope-exit cleanup plans are implemented. Add constructs only
   with an end-to-end fixture. Continue to
   invoke Clang as an external tool; self-hosting does not require replacing it.
6. Move module loading, project driving, files/paths/processes, diagnostics, and
   command-line orchestration into the Z driver, then remove the corresponding
   TypeScript/Bun paths only after parity. This step now has an end-to-end
   vertical slice: native
   standard-call evidence now covers `std/fs` and `std/process`, and an emitted
   executable receives owned `Array<String>` arguments, checks and reads UTF-8
   files, and handles `Result<String, String>` entirely outside Bun. The
   application-shaped source stager also writes the owned source, launches
   Clang without a shell, handles typed process failures, and flushes
   interpolated console output from the native executable. The native driver
   recursively discovers local `.zs` imports and exposes native `check`, `emit`,
   `build`, and project-cache `run` commands over one parsed and resolved
   graph. `emit` writes C without invoking Clang; `build` writes C and invokes
   it, producing a separate two-module application without Bun; `run` creates
   missing `.z-cache/run` parents, retains its generated C and executable there,
   and skips Clang when exact emitted C plus profile, target, toolchain, and
   foreign evidence are unchanged. It launches that artifact without a shell
   and forwards program arguments. `check`
   accepts export-only modules, while executable commands diagnose missing or
   incompatible `main` in Z before Clang. `build` and `run` default to `-O0`
   and accept `--release` for `-O2 -DNDEBUG`. Native parse and semantic
   failures render their Z source line and caret without Stage 0. The native
   command now finds and parses `z.json`, validates its entry and configured
   directories, deduplicates libraries, and supplies include/link directories,
   native libraries, and a macOS minimum target to Clang. Swift target
   preparation, broader foreign declarations, cross-platform target selection,
   manifest-selected/custom profiles, richer diagnostics,
   general console formatting,
   native-library cache identities, and complete production options remain.
   Automatic first-tier foreign discovery now invokes `z-foreign-adapter` and
   optionally loads an adjacent `.zd`. Header-derived declarations do not need
   an empty sidecar; a C callable without checked facts is rejected where it is
   used rather than at import. Unsupported evidence still fails closed instead
   of claiming the resolver received facts that were never produced. Version 6
   of the raw-declaration protocol crosses scalar typedef
   evidence, nominal enums, typed native constants, record layouts/fields,
   canonical C record identity across typedef aliases, function
   names, namespaces, overloads, parameter type spellings, source locations,
   executor affinity, and availability into owned Z storage. It is intentionally producer-facing
   rather than trusted FIIR. Unrelated declarations outside this tier are
   projected away, while exact function type spellings ensure a contract that
   actually needs unsupported evidence still fails closed. The real Clang
   producer now supplies this function-and-constant stream. The standalone
   adapter command writes it and the native driver validates it. The first
   native `.zd` tiers normalize inferred scalar; decimal, symbolic scalar, or
   nominally enum-backed integer-status; and recursively copyable record value or
   pointer declarations against that evidence. The first ownership-bearing
   record tier verifies `move` plus `deinit`, requires producers to declare
   `owned` or non-escaping `borrowed`, preserves unique moves through native
   sema, and emits deterministic release calls without wrapping the C ABI. The
   following opaque-pointer tier verifies nullable direct and `out T**`
   producers, status-failure cleanup, null narrowing, `Option.fromNullable`,
   consuming release calls, and non-escaping borrowed pointer results with the
   same direct ABI.
   These contracts feed native sema and emit executable direct
   scalar/status/record calls. Project-local
   target-aware artifacts now
   reuse preprocessor-validated hits and invalidate on transitive header
   changes; ordinary foreign enum parameters/constants now retain verified
   nominal identity through native semantic checking and lowering, while cache
   locking/eviction, exact range checks, and broader contract facts remain.
7. Keep the consecutive-generation fixed-point gate and complete test/corpus
   results green. A cold preparation now builds the compiler with Stage 0,
   executes that native compiler to emit itself again, and requires byte-exact
   C output before caching the library. The standalone command follows the same
   rule: generation one builds its own 39-module graph, generation-two C must be
   byte-identical, and the rebuilt command checks a separate project. A separate
   27-program differential corpus sends the same supported Z sources through
   Stage 0 and the native compiler, strict-compiles both C artifacts in release
   mode, executes them with identical arguments, and requires matching exit
   status, standard output, and standard error. This covers collections, typed
   results, cleanup-bearing values, native lexing, and a multi-module filesystem
   application rather than relying on the compiler fixed point alone. The macOS
   CI gate runs the complete suite, including both proofs, on every push and
   pull request. `bun run bootstrap [output]` now executes that complete gate
   and publishes the resulting local executable under the public name `z` plus
   its adjacent standalone metadata adapter. The remaining release step is to
   sign, version, and ship those trusted platform artifacts so ordinary
   installations do not need Stage 0.

The next self-hosting sprint should begin when duplicated Stage-0 semantics are
slowing language work, a new feature exposes a native corpus gap worth closing,
or the compiler subset has the collections and APIs needed for lowering. Direct
Swift ABI support, actors/channels, complete async executors, and unrelated
language breadth are not prerequisites. Until then, self-hosting proceeds
incrementally alongside language design rather than ahead of it.
