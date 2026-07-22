# Project index

This cross-platform application pressure-tests ordinary Z ownership and
collections without a native framework dependency. It indexes source paths into
owned `Map<String, FileRecord>` storage, tracks unsaved paths with `Set<String>`,
and reads files through `std/fs`.

The model deliberately combines recently landed language features:

- `Map.get` returns `Option<view FileRecord>` for allocation-free lookup;
- `copy record` materializes an independent snapshot that survives mutation;
- replacing a record destroys the previous owned strings exactly once;
- `move report` hands a whole owned report to its final consumer;
- `IndexError` carries typed owned path/message values without requiring a
  universal error base type; and
- the same program will remain unchanged when collection storage moves from the
  current dense representation to hashed buckets.

Run the deterministic ownership smoke test:

```sh
bun run z run examples/applications/project-index/smoke.zs
```

Run the fixed 4,000-entry Map/Set workload used to compare dense and hashed
storage without changing application source:

```sh
bun run z run examples/applications/project-index/benchmark.zs
```

Index real files:

```sh
bun run z run examples/applications/project-index/main.zs -- \
  compiler/frontend/lexer.zs compiler/frontend/parser.zs
```
