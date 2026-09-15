import {
  assert, check, cli, compileToNative, diagnostics, hostToolchainTest,
  mkdtempSync, projectRoot, readFileSync, resolve, rmSync, spawnSync, test, writeFileSync,
} from "./support/bootstrap.ts";

const project = resolve(projectRoot, "examples/interop/c/z-bytes-export");
const library = readFileSync(resolve(project, "library.zs"), "utf8");
const source = library + `
type Bytes = Slice<u8>;
export c function aliasedBytes(bytes: Bytes): usize { return bytes.length; }
export c function names(bytes: Slice<u8>, bytes_data: usize, bytes_length: usize,
  other: Slice<u8>, self: usize): usize {
  return bytes.length + bytes_data + bytes_length + other.length + self;
}
export c function ignoreBytes(bytes: Slice<u8>): void {}
function main(): i32 {
  const bytes = Array<u8>(65, 0, 255, 66);
  if (byteCount(bytes) != 4 || byteSum(bytes) != 386) return 1;
  if (combinedByteCount(bytes, bytes) != 8 || aliasedBytes(bytes) != 4) return 2;
  return 0;
}
`;
const invalid = [
  { source: 'export c function bad(bytes: Slice<u16>): usize { return bytes.length; }', message: /unsupported boundary type/ },
  { source: 'export c function bad(bytes: Array<u8>): usize { return bytes.length; }', message: /unsupported boundary type/ },
  { source: 'export c function bad(bytes: cstring): void {}', message: /unsupported boundary type/ },
  { source: 'export c function bad(in bytes: Slice<u8>): void {}', message: /cannot use `in`|without a capability prefix|already borrowed/ },
  { source: 'export c function bad(inout bytes: Slice<u8>): void {}', message: /cannot use `inout`|without a capability prefix/ },
  { source: 'export c function bad(out bytes: Slice<u8>): void {}', message: /cannot use `out`|without a capability prefix|out Slice/ },
  { source: 'export c function bad(bytes: Slice<u8>): Slice<u8> { return bytes; }', message: /return type.*unsupported|returning Slice/ },
  { source: 'export c async function bad(bytes: Slice<u8>): void {}', message: /cannot be async/ },
  { source: 'export c function bad(bytes: Slice<u8>): void throws String {}', message: /cannot throw/ },
  { source: 'export c function bad(bytes: Slice<u8>): void { bytes[0] = 0; }', message: /immutable|borrowed|read.only/ },
  { source: 'struct Holder { bytes: Slice<u8>; } export c function bad(bytes: Slice<u8>): void {}', message: /Slice.*(stored|field)/ },
  { source: 'export c function bad(bytes: Slice<u8>): void { const saved = bytes; }', message: /Slice.*local/ },
  { source: 'export c function bad(bytes: Slice<u8>): void { let saved: Slice<u8>; saved = bytes; }', message: /Slice.*local/ },
  { source: 'export c function bad(bytes: Slice<u8>): void { const read = move (): usize => bytes.length; }', message: /captur.*(bytes|Slice)|Slice.*captur/ },
  { source: 'export c function bad(bytes: Slice<u8>): void { const read = (): usize => bytes.length; }', message: /captur.*(bytes|Slice)|Slice.*captur/ },
  { source: 'type Bytes = Slice<u8>; export c function bad(bytes: Bytes): void { bytes[0] = 0; }', message: /immutable|borrowed|read.only/ },
  { source: 'type Bytes = Slice<u8>; struct Holder { bytes: Bytes; } export c function bad(bytes: Bytes): void {}', message: /Slice.*(stored|field)/ },
  { source: 'enum Saved { bytes Slice<u8>, } export c function bad(bytes: Slice<u8>): void {}', message: /Slice.*(stored|payload)/ },
  { source: 'function fill(inout bytes: Slice<u8>): void { bytes[0] = 0; } export c function bad(bytes: Slice<u8>): void { fill(inout bytes); }', message: /mutable|borrowed|read.only/ },
  { source: 'struct Holder<T> { bytes: T; } export c function bad(bytes: Slice<u8>): void { const holder = Holder<Slice<u8>>({ bytes }); }', message: /Slice.*(stored|field|local)/ },
];

function run(executable: string, args: string[], timeout = 180_000) {
  return spawnSync(executable, args, {
    encoding: "utf8", timeout, killSignal: "SIGKILL", maxBuffer: 32 * 1024 * 1024,
  });
}

test("C byte inputs expose pointer-length pairs without exposing private Slice layout", () => {
  const artifact = compileToNative(source, "byte-exports.zs");
  assert.ok(artifact.header);
  assert.match(artifact.header, /uintptr_t byteCount\(const uint8_t \*bytes_data, uintptr_t bytes_length\);/);
  assert.match(artifact.header, /uintptr_t aliasedBytes\(const uint8_t \*bytes_data, uintptr_t bytes_length\);/);
  assert.match(artifact.header, /names\(const uint8_t \*_z_export_0_data, uintptr_t _z_export_0_length, uintptr_t bytes_data, uintptr_t bytes_length, const uint8_t \*other_data, uintptr_t other_length, uintptr_t _z_binding_self\)/);
  assert.doesNotMatch(artifact.header, /Z_Slice|__z_slice/);
  const wrapper = artifact.source.slice(artifact.source.lastIndexOf("Z_API uintptr_t byteCount("));
  assert.match(wrapper, /if \(bytes_data == NULL && bytes_length != 0\) abort\(\)/);
  assert.doesNotMatch(wrapper, /malloc|memcpy|strlen|utf8|z_string_from_cstring/);
  for (const input of invalid) {
    const text = input.source + '\nfunction main(): i32 { return 0; }';
    assert.throws(() => check(text, "invalid-bytes.zs"), input.message, input.source);
    assert.ok(diagnostics(text, "invalid-bytes.zs").length > 0, input.source);
  }
});

hostToolchainTest("borrowed C byte inputs execute without text conversion in both compilers", () => {
  const directory = mkdtempSync("/tmp/z-c-byte-input-");
  try {
    const path = resolve(directory, "bytes.zs");
    writeFileSync(path, source);
    const artifact = compileToNative(source, path);
    const native = run(process.execPath, [cli, "self-host-emit", path]);
    assert.equal(native.status, 0, native.stderr);
    writeFileSync(resolve(directory, "zbytes.h"), artifact.header!);
    const consumer = resolve(directory, "consumer.c");
    writeFileSync(consumer, `#include "zbytes.h"
      #include <stddef.h>
      #ifdef __cplusplus
      extern "C" int generated_main(void);
      #else
      int generated_main(void);
      #endif
      int main(int argc, char **argv) {
        (void)argv;
        if (argc > 1) { ignoreBytes(NULL, 1); return 90; }
        const uint8_t bytes[] = {65, 0, 255, 66};
        if (byteCount(bytes, 4) != 4 || byteSum(bytes, 4) != 386) return 1;
        if (byteCount(NULL, 0) != 0 || byteSum(NULL, 0) != 0) return 2;
        if (byteCount(bytes, 0) != 0) return 3;
        if (combinedByteCount(bytes, 4, bytes, 4) != 8) return 4;
        if (aliasedBytes(bytes, 4) != 4) return 5;
        if (names(bytes, 4, 10, 20, bytes, 4, 30) != 68) return 6;
        ignoreBytes(NULL, 0);
        return generated_main();
      }
    `);
    for (const [compiler, generated] of [artifact.source, native.stdout].entries()) {
      const wrapper = generated.slice(generated.lastIndexOf("Z_API uintptr_t byteCount("));
      assert.doesNotMatch(wrapper, /malloc|memcpy|strlen|utf8|string_from_cstring/);
      const output = resolve(directory, "bytes.c");
      // Exercise traps without generating a macOS crash report or a dangling process.
      writeFileSync(output, `#include <stdlib.h>
        static void invalid_input(void) { _Exit(73); }
        #define abort invalid_input
        #define main generated_main
        ${generated}
      `);
      for (const optimization of ["-O0", "-O2"]) {
        const object = resolve(directory, "bytes.o");
        const built = run("clang", [output, "-std=c11", optimization, "-Wall", "-Wextra", "-Werror",
          "-fsanitize=undefined", "-fno-sanitize-recover=all", "-c", "-o", object]);
        assert.equal(built.status, 0, `${compiler}: ${built.stderr}`);
        for (const cpp of [false, true]) {
          const executable = resolve(directory, "consumer");
          const linked = run(cpp ? "clang++" : "clang", [
            "-x", cpp ? "c++" : "c", cpp ? "-std=c++20" : "-std=c11", "-Wall", "-Wextra", "-Werror",
            consumer, "-x", "none", object, "-fsanitize=undefined", "-pthread", "-o", executable,
          ]);
          assert.equal(linked.status, 0, linked.stderr);
          const result = run(executable, [], 10_000);
          assert.equal(result.status, 0, `${compiler}, ${optimization}, cpp=${cpp}: ${result.stderr}`);
          assert.equal(run(executable, ["null"], 10_000).status, 73);
        }
      }
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 300_000);

hostToolchainTest("native byte exports reject mutable and escaping boundary shapes before C emission", () => {
  const directory = mkdtempSync("/tmp/z-c-byte-rejection-");
  try {
    const path = resolve(directory, "invalid.zs");
    const failures: string[] = [];
    for (const input of invalid) {
      writeFileSync(path, input.source + '\nfunction main(): i32 { return 0; }');
      const result = run(process.execPath, [cli, "self-host-emit", path]);
      if (result.status === 0 || !input.message.test(result.stderr)) {
        failures.push(`${input.source}\nstatus=${result.status}: ${result.stderr}`);
      }
    }
    assert.deepEqual(failures, []);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 300_000);
