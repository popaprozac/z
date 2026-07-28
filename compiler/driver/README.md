# Native Z compiler driver

`main.zs` is the first standalone compiler command implemented in Z. Once
Stage 0 emits it and Clang builds it, the resulting executable:

1. reads an entry `.zs` file through `std/fs`;
2. canonicalizes module identity and discovers relative `.zs` imports
   recursively;
3. parses and resolves the complete module graph through the native frontend;
4. lowers that graph to readable C;
5. writes `<output>.c`; and
6. invokes Clang directly to produce `<output>`.

The resulting compilation path does not execute Bun or TypeScript. The current
command is intentionally smaller than the production `z` CLI:

```text
z-native check <entry.zs>
z-native emit <entry.zs> <output.c>
z-native build <entry.zs> <output>
```

It supports the self-hosting language and runtime subset. Project manifests,
foreign header discovery, target configuration, release profiles, polished
diagnostics, `run`, and the complete production command options remain with
Stage 0 until equivalent native paths are proven.
