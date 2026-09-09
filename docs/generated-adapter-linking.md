# Generated adapter linking

Status: approved and implemented in both compiler paths. No new Z syntax,
Zapp service API, or `.zbuild.json` key is introduced.

## Reproduced problem

At Z `601c7f9`, an application can declare an exported value type beside `main`
and pass it to a generic registration marker. Checking that authored graph
succeeds. A generated adapter that imports the type from that entry module is
also an ordinary, reasonable dependency on the application's declarations.

Applying the existing source-hashed `callAdapters` overlay currently adds a
synthetic import to the caller before linking. This creates the graph:

```text
main.zs -> generated/adapters.zs -> main.zs
           synthetic edge         authored import in generated source
```

Both Stage 0 and the fixed-point native compiler reject it as a circular Z
module import. The reduced probe uses no AppKit, async machinery, or Zapp
runtime: `Builder.register<T>` adapts an entry-defined `Payload` into an `i32`
for the same receiver's internal `install` method. The base graph checks; both
adapted graphs fail. The expected successful executable would return zero
after the adapter changes the payload's value from 41 to 42.

Relevant implementation points:

- Stage 0: `applyGeneratedCallAdaptersToProgram` appends an import, and
  `loadSourceModuleBatch` traverses it during ordinary cycle detection.
- Native: `appendAdapterImport` appends the analogous declaration; the second
  semantic pass includes it in `resolveModuleOrder`.
- Zapp: the dispatcher generator imports service and wire types from their
  declaring modules. That behavior should not force a new end-user service API.

## Contract

Distinguish compiler-generated adapter references from authored source imports.
Validate the ordinary source-import graph, including the ordinary imports
written inside generated modules, before linking the validated adapter calls.

1. Discover both application modules and required generated modules. Ordinary
   import cycles remain errors, even when a participating file is generated.
2. Preserve the existing source hash, source-site, original method, same-receiver
   replacement, package identity, and exported adapter checks.
3. Treat only references introduced by a validated call-adapter record as
   generated function links. They must not invent an ordinary import cycle.
   Do not infer this privilege from filenames or identifier prefixes.
4. Fully type-check the adapted calls and generated bodies. This grants no new
   private/internal access and does not bypass ownership, affinity, or errors.
5. Preserve ordinary declaration and module-initialization dependencies.
   Generated linking must not accidentally legalize an initialization or type
   layout cycle. Include generated modules in emission and cache dependencies
   without using an arbitrary cyclic traversal as their initialization order.
6. Retain source-mapped diagnostics and cache invalidation for edited source,
   generated code, and overlays.

This is not a proposal for general circular imports, `import type`, generated
declarations injected into a source module, or implicit access to private
service types. Those would be separate language/build-contract decisions.

## Alternatives not recommended for this gap

- Require every service to live in a separate file: a useful current workaround,
  but not a satisfying requirement for otherwise valid single-file applications.
- Allow all module cycles: substantially broader semantics than this generated
  reference problem requires.
- Splice generated declarations into the source module: possible future work,
  but adds a different visibility and source-mapping contract unnecessarily here.

## Implementation and verification

Only the validated call-adaptation transform creates an internal
`generatedAdapterLink` on its import-shaped name binding. The source parser
cannot set it. Name and visibility resolution still use the normal imported
export checks. Stage 0 finishes ordinary dependency discovery before loading
adapter roots; native ordering skips only these explicitly marked edges.
Both include generated roots in emission, then follow each root's ordinary
imports. A real source import to an adapter is never exempt, even if its local
name resembles a compiler-generated identifier.

The shared executable regression in
`tests/support/generated-adapter-linking.ts` is called by both compiler suites.
It checks an entry-defined move-only Payload, two entry call sites, a third
registration in an imported module, constants imported back from the entry,
and a generated-only ordinary constant dependency. Output proves each argument
is evaluated and destroyed once. Changing that dependency after a build/reuse
changes the executable result. Negative cases exercise real source cycles,
generated-only cycles, private types, unexported adapters, bad result types, and
unsupported runtime module initialization. Existing adapter tests retain the
source-hash, exact-target, and package-scoped internal-access rejection cases.

The full Zapp probe additionally exposed forward result-type evidence: an adapter
can return its own ARC implementation into a generic replacement before that
generated module's bodies are lowered. The native caller now receives the
checked generic-argument ABI/cleanup evidence early, without changing ordinary
module order. The reduced matrix covers distinct ARC adapter results owning the
entry's move-only payloads, plus a shared adapter type used from several modules.
Per-caller evidence must not depend on which consumer first requested a globally
deduplicated generic specialization.

That matrix also exposed shared semantic offsets in Stage 0's ordinary generic
method instances. Each concrete method now gets fresh semantic sites so the
receiver type for one trait implementation cannot overwrite another instance's
member-call evidence. An independent test covers instance methods, static
methods, and methods on a generic owner without generated code.

Module constants still have the existing literal/Once/embed initialization
restrictions. This change does not introduce arbitrary runtime initializers or
permit recursive value layouts. A future runtime-initialization tier must model
its dependencies explicitly; generated call references are not such a model.

The complete integration gate is Zapp's isolated Application.run startup test,
now with its exported service class beside `main` rather than in a required
separate service file.

Checkpoint gates:

- Reproduce a same-entry exported service/value type with the current overlay in
  both drivers, then run the adapted program and verify its result.
- Cover multiple adapters, an imported registration site, and an owned service
  identity so each source argument is evaluated and transferred exactly once.
- Keep ordinary source cycles and ordinary cycles within generated modules
  rejected, including cycles reachable only through a generated module.
- Keep missing exports, private/internal access failures, stale source hashes,
  wrong targets, and incompatible adapter results rejected.
- Verify generated modules' ordinary constant/type dependencies and reject real
  dependency cycles rather than hiding them behind generated-link provenance.
- Rebuild after edits to generated code and after cache hits; run fixed-point
  parity, then the isolated Zapp Application.run gate with a service beside main.

Use bounded subprocesses and existing UBSan checks; do not introduce ASan probes
or loosen source-cycle checks as a shortcut.

Final checkpoint: all 232 self-hosting, 97 module/collection, and 98 async tests
pass. Both compiler paths also execute the expanded ARC-result matrix under
UBSan. The rebuilt native compiler reaches a byte-identical fixed point
(10,965,112 C bytes). Zapp's complete signed native startup gate, both TypeScript
check projects, and the Z website build pass. No ASan process was launched.
