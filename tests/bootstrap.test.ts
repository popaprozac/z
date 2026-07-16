import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { test } from "bun:test";
import { compileToC, compileToNative } from "../compiler/src/compiler.ts";

const projectRoot = resolve(dirnameFromImportMeta(), "..");
const cli = resolve(projectRoot, "compiler/src/cli.ts");

test("emits functions and direct imported C calls", () => {
  const source = `
    import stdio from "stdio.h";
    function main(): i32 {
      stdio.puts("hello");
      return 0;
    }
  `;
  const generated = compileToC(source, "memory.z");
  assert.match(generated, /#include <stdio\.h>/);
  assert.match(generated, /puts\("hello"\);/);
  assert.doesNotMatch(generated, /stdio\.puts/);
});

test("selectively imports C functions with optional local aliases", () => {
  const example = resolve(projectRoot, "examples/selective-import.z");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "selective C imports\nanswer=42\n");

  const generated = compileToC(readFileSync(example, "utf8"), example);
  assert.match(generated, /puts\("selective C imports"\);/);
  assert.match(generated, /printf\("answer=%d\\n", 42\);/);
  assert.doesNotMatch(generated, /\bprint\(/);

  const shadowed = `
    import { printf as value } from "stdio.h";
    function main(): i32 {
      const value = 7;
      return value;
    }
  `;
  const shadowedC = compileToC(shadowed, "selective-shadow.z");
  assert.match(shadowedC, /const int32_t value = 7;/);
  assert.match(shadowedC, /return value;/);
  assert.doesNotMatch(shadowedC, /return printf;/);
});

test("keeps unselected C functions out of scope", () => {
  const source = `
    import { puts } from "stdio.h";
    function main(): i32 {
      printf("not imported");
      return 0;
    }
  `;
  assert.throws(
    () => compileToC(source, "selective-scope.z"),
    /unknown function "printf"/,
  );

  const missing = source.replace("puts", "not_a_real_c_function").replace("printf", "not_a_real_c_function");
  assert.throws(
    () => compileToC(missing, "selective-missing.z"),
    /header "stdio\.h" has no declaration "not_a_real_c_function"/,
  );
});

test("selectively imports C types and constants with the same aliases used by functions", () => {
  const example = resolve(projectRoot, "examples/selective-declarations.z");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "selective point=23,19 score=42\n");

  const generated = compileToC(readFileSync(example, "utf8"), example);
  assert.match(generated, /static ZDirection direction\(void\)/);
  assert.match(generated, /return ZForward;/);
  assert.match(generated, /static ZPoint shift\(ZPoint point, ZCount amount\)/);
  assert.match(generated, /return z_translate\(point, direction\(\), amount\);/);
  assert.match(generated, /const ZPoint point = \(ZPoint\)\{ \.x = 20, \.y = 19 \};/);
  assert.doesNotMatch(generated, /\b(Point|Direction|Count|forward|translate|score)\s*\(/);
});

test("keeps unselected C types and constants out of scope", () => {
  const missingType = `
    import { z_score } from "tests/fixtures/geometry.h";
    function inspect(point: ZPoint): i32 { return z_score(point); }
    function main(): i32 { return 0; }
  `;
  assert.throws(
    () => compileToC(missingType, resolve(projectRoot, "selective-type-scope.z")),
    /unknown type "ZPoint"/,
  );

  const missingConstant = `
    import { ZDirection } from "tests/fixtures/geometry.h";
    function main(): i32 {
      const direction: ZDirection = ZForward;
      return 0;
    }
  `;
  assert.throws(
    () => compileToC(missingConstant, resolve(projectRoot, "selective-constant-scope.z")),
    /unknown name "ZForward"/,
  );
});

test("shares imported C type identity across namespace and selective imports", () => {
  const source = `
    import geometry from "tests/fixtures/geometry.h";
    import { ZPoint as Point, z_read } from "tests/fixtures/geometry.h";
    function main(): i32 {
      const point: Point = geometry.ZPoint { x: 20, y: 22 };
      return z_read(point);
    }
  `;
  const generated = compileToC(source, resolve(projectRoot, "selective-record.z"));
  assert.match(generated, /return z_read\(&\(point\)\);/);
});

test("imports C function signatures through Clang", () => {
  const source = `
    import stdio from "stdio.h";
    function main(): i32 {
      const written = stdio.puts("typed");
      return written;
    }
  `;
  const generated = compileToC(source, "typed-header.z");
  assert.match(generated, /const int32_t written = puts\("typed"\);/);
});

test("rejects unknown functions from imported headers", () => {
  const source = `
    import stdio from "stdio.h";
    function main(): i32 {
      return stdio.not_a_real_function("nope");
    }
  `;
  assert.throws(
    () => compileToC(source, "foreign-name.z"),
    /header "stdio\.h" has no function "not_a_real_function"/,
  );
});

test("checks fixed C arguments and variadic boundaries", () => {
  const wrongType = `
    import stdio from "stdio.h";
    function main(): i32 {
      return stdio.puts(42);
    }
  `;
  assert.throws(
    () => compileToC(wrongType, "foreign-type.z"),
    /expected cstring, found i32/,
  );

  const missingFormat = `
    import stdio from "stdio.h";
    function main(): i32 {
      return stdio.printf();
    }
  `;
  assert.throws(
    () => compileToC(missingFormat, "foreign-variadic.z"),
    /C function "printf" expects at least 1 argument\(s\), found 0/,
  );
});

test("reports unsupported C signatures at the Z call site", () => {
  const source = `
    import stdio from "stdio.h";
    function main(): i32 {
      stdio.freopen("file", "r", "unsupported");
      return 0;
    }
  `;
  assert.throws(
    () => compileToC(source, "foreign-pointer.z"),
    /C function "freopen" uses unsupported type "FILE \*"/,
  );
});

test("narrows, borrows, consumes, and cleans up owned C handles", () => {
  const example = resolve(projectRoot, "examples/foreign-handle.z");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "wrote handle\n");
  assert.equal(readFileSync("/tmp/z-lang-foreign-handle.txt", "utf8"), "owned by Z\n");

  const source = `
    import stdio from "stdio.h";
    function main(): i32 {
      const file = stdio.fopen("/tmp/z-lang-double-close.txt", "w");
      if (!file) { return 1; }
      stdio.fclose(file);
      return stdio.fclose(file);
    }
  `;
  assert.throws(
    () => compileToC(source, "foreign-consume.z"),
    /use of moved value "file"/,
  );
});

test("discovers ownership notes beside project headers", () => {
  const source = `
    import handles from "tests/fixtures/foreign-handles.h";
    function main(): i32 {
      const handle = handles.z_test_open();
      if (!handle) { return 1; }
      return handles.z_test_use(handle);
    }
  `;
  const generated = compileToC(source, resolve(projectRoot, "foreign-local-notes.z"));
  assert.match(generated, /ZTestHandle \* const handle = z_test_open\(\);/);
  assert.match(generated, /if \(_z_live_handle_0 && handle != NULL\) z_test_close\(handle\);/);
});

test("imports C typedefs, records, enums, constants, and qualified signatures", () => {
  const example = resolve(projectRoot, "examples/foreign-types.z");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "point=13,20 width=640 flags=7 id=42\n");

  const generated = compileToC(readFileSync(example, "utf8"), example);
  assert.match(generated, /static ZPoint move\(ZPoint point, ZCount amount\)/);
  assert.match(generated, /\(ZPoint\)\{ \.x = 10, \.y = 20 \}/);
  assert.match(generated, /z_translate\(point, ZForward, amount\)/);
});

test("checks contextual literals and preserves exact integer expression types", () => {
  const source = `
    function plus(value: u16): u16 {
      const result = value + 3;
      return result;
    }
    function maxWord(): u32 {
      return 4294967295;
    }
    function maxWide(): u64 {
      return 18446744073709551615;
    }
    function main(): i32 {
      plus(65535);
      return 0;
    }
  `;
  const generated = compileToC(source, "integer-widths.z");
  assert.match(generated, /static uint16_t plus\(uint16_t value\)/);
  assert.match(generated, /const uint16_t result = \(value \+ 3\);/);
  assert.match(generated, /return 4294967295U;/);
  assert.match(generated, /return 18446744073709551615ULL;/);

  assert.throws(
    () => compileToC(source.replace("65535", "65536"), "integer-overflow.z"),
    /integer literal 65536 does not fit u16/,
  );

  const inferredWide = `
    function main(): i32 {
      const value = 4294967295;
      return 0;
    }
  `;
  assert.throws(
    () => compileToC(inferredWide, "integer-default.z"),
    /does not fit default i32; add an explicit integer type/,
  );
});

test("runs floating-point values and typed bitwise option masks", () => {
  const example = resolve(projectRoot, "examples/apple-groundwork.z");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");

  const artifact = compileToNative(readFileSync(example, "utf8"), example);
  assert.equal(artifact.language, "c");
  assert.deepEqual(artifact.frameworks, []);
  assert.match(artifact.source, /static float twice\(float value\)/);
  assert.match(artifact.source, /static double negate\(double value\)/);
  assert.match(artifact.source, /const float width = 800\.0F;/);
  assert.match(artifact.source, /const ZCoordinate windowArea = z_area\(800\.0, 600\.0\);/);
  assert.match(artifact.source, /const uintptr_t styleMask = \(\(titled \| 2ULL\) \| 8ULL\);/);
  assert.match(artifact.source, /const uint32_t shifted = \(one << 3U\);/);
  assert.match(artifact.source, /const uint32_t inverted = \(~one\);/);
  assert.match(artifact.source, /const uintptr_t toggled = \(filtered \^ 1ULL\);/);
  assert.match(artifact.source, /const float scientific = 1\.5e2F;/);
});

test("checks floating-point widths and integer-only bitwise operators", () => {
  const mismatch = `
    function accept(value: f32): void {}
    function main(): i32 {
      const value: f64 = 1.25;
      accept(value);
      return 0;
    }
  `;
  assert.throws(() => compileToC(mismatch, "float-width.z"), /expected f32, found f64/);

  const floatToInteger = `
    function main(): i32 {
      const value: i32 = 1.5;
      return value;
    }
  `;
  assert.throws(
    () => compileToC(floatToInteger, "float-to-integer.z"),
    /floating-point literal 1\.5 cannot initialize i32/,
  );

  const floatMask = `
    function main(): i32 {
      const mask = 1.0 | 2.0;
      return 0;
    }
  `;
  assert.throws(
    () => compileToC(floatMask, "float-mask.z"),
    /operator "\|" requires matching integer operands/,
  );

  const variadicFloat = `
    import stdio from "stdio.h";
    function main(): i32 {
      stdio.printf("%.1f", 1.5);
      return 0;
    }
  `;
  assert.match(compileToC(variadicFloat, "variadic-float.z"), /printf\("%\.1f", 1\.5\)/);
});

test("accepts null only at explicitly nullable foreign boundaries", () => {
  const nullable = `
    import handles from "tests/fixtures/foreign-handles.h";
    function main(): i32 {
      handles.z_test_optional(null);
      return 0;
    }
  `;
  assert.match(
    compileToC(nullable, resolve(projectRoot, "nullable-null.z")),
    /z_test_optional\(NULL\);/,
  );

  const nonnull = nullable.replace("z_test_optional", "z_test_use");
  assert.throws(
    () => compileToC(nonnull, resolve(projectRoot, "nonnull-null.z")),
    /C function "z_test_use" requires a non-null ZTestHandle \*/,
  );

  const inferred = `
    function main(): i32 {
      const absent = null;
      return 0;
    }
  `;
  assert.throws(
    () => compileToC(inferred, "inferred-null.z"),
    /cannot infer a type from null; provide an explicitly nullable type/,
  );
});

test("checks imported C record fields and enum arguments in Z", () => {
  const missingField = `
    import geometry from "tests/fixtures/geometry.h";
    function main(): i32 {
      const point = geometry.ZPoint { x: 1 };
      return point.x;
    }
  `;
  assert.throws(
    () => compileToC(missingField, resolve(projectRoot, "foreign-record-fields.z")),
    /missing field "y" when constructing "geometry\.ZPoint"/,
  );

  const wrongEnum = `
    import geometry from "tests/fixtures/geometry.h";
    function main(): i32 {
      const point = geometry.ZPoint { x: 1, y: 2 };
      const moved = geometry.z_translate(point, 1, 3);
      return moved.x;
    }
  `;
  assert.throws(
    () => compileToC(wrongEnum, resolve(projectRoot, "foreign-enum-argument.z")),
    /expected geometry\.ZDirection, found i32/,
  );
});

test("borrows and explicitly mutates imported C records through safe pointer modes", () => {
  const example = resolve(projectRoot, "examples/foreign-pointers.z");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "before=10 after=11 point=5,6\n");

  const generated = compileToC(readFileSync(example, "utf8"), example);
  assert.match(generated, /z_offset\(&\(point\), 3, 4\);/);
  assert.match(generated, /z_read\(&\(point\)\)/);
  assert.match(generated, /z_reset\(&\(point\)\);/);
});

test("requires exact pointer modes and mutable storage at imported record boundaries", () => {
  const uninitializedOutput = `
    import geometry from "tests/fixtures/geometry.h";
    function main(): i32 {
      let point: geometry.ZPoint;
      geometry.z_reset(out point);
      return point.x;
    }
  `;
  const uninitializedOutputC = compileToC(
    uninitializedOutput,
    resolve(projectRoot, "foreign-record-uninitialized-out.z"),
  );
  assert.match(uninitializedOutputC, /ZPoint point;/);
  assert.match(uninitializedOutputC, /z_reset\(&\(point\)\);/);

  const immutable = `
    import geometry from "tests/fixtures/geometry.h";
    function main(): i32 {
      const point = geometry.ZPoint { x: 1, y: 2 };
      geometry.z_reset(out point);
      return 0;
    }
  `;
  assert.throws(
    () => compileToC(immutable, resolve(projectRoot, "foreign-record-const.z")),
    /out argument "point" requires a mutable let binding/,
  );

  const missingMode = `
    import geometry from "tests/fixtures/geometry.h";
    function main(): i32 {
      let point = geometry.ZPoint { x: 1, y: 2 };
      geometry.z_offset(point, 3, 4);
      return 0;
    }
  `;
  assert.throws(
    () => compileToC(missingMode, resolve(projectRoot, "foreign-record-mode.z")),
    /requires inout <mutable binding> for parameter 1/,
  );

  const wrongMode = `
    import geometry from "tests/fixtures/geometry.h";
    function main(): i32 {
      let point = geometry.ZPoint { x: 1, y: 2 };
      geometry.z_reset(inout point);
      return 0;
    }
  `;
  assert.throws(
    () => compileToC(wrongMode, resolve(projectRoot, "foreign-record-wrong-mode.z")),
    /expects out point, found inout point/,
  );

  const escapedModifier = `
    function use(value: i32): void {}
    function main(): i32 {
      let value = 1;
      use(out value);
      return 0;
    }
  `;
  assert.throws(
    () => compileToC(escapedModifier, "escaped-out.z"),
    /out is not valid for an owned value parameter/,
  );
});

test("requires nullable C handles to be checked before borrowing", () => {
  const source = `
    import stdio from "stdio.h";
    function main(): i32 {
      const file = stdio.fopen("/tmp/z-lang-nullable.txt", "w");
      stdio.fputs("unsafe", file);
      return 0;
    }
  `;
  assert.throws(
    () => compileToC(source, "foreign-nullability.z"),
    /nullable FILE \* must be checked before passing it to "fputs"/,
  );
});

test("does not treat mutable C strings as safe cstrings", () => {
  const supportedSource = `
    import fixture from "tests/fixtures/foreign-types.h";
    function main(): i32 {
      return fixture.z_test_bool(true);
    }
  `;
  assert.match(
    compileToC(supportedSource, resolve(projectRoot, "foreign-bool.z")),
    /return z_test_bool\(true\);/,
  );

  const source = `
    import fixture from "tests/fixtures/foreign-types.h";
    function main(): i32 {
      return fixture.z_test_mutate("immutable");
    }
  `;
  assert.throws(
    () => compileToC(source, resolve(projectRoot, "mutable-cstring.z")),
    /C function "z_test_mutate" uses unsupported type "char \*"/,
  );
});

test("reports headers Clang cannot import", () => {
  const source = `
    import missing from "z_header_that_does_not_exist.h";
    function main(): i32 { return 0; }
  `;
  assert.throws(
    () => compileToC(source, "missing-header.z"),
    /could not import header "z_header_that_does_not_exist\.h"/,
  );
});

test("reports source locations for parser errors", () => {
  assert.throws(
    () => compileToC("function main(: i32 {}", "broken.z"),
    /broken\.z:1:15: error:/,
  );
});

test("rejects unknown names during semantic analysis", () => {
  const source = `
    function main(): i32 {
      return missing;
    }
  `;
  assert.throws(
    () => compileToC(source, "unknown.z"),
    /unknown\.z:3:14: error: unknown name "missing"/,
  );
});

test("checks Z function arguments", () => {
  const source = `
    function identity(value: i32): i32 {
      return value;
    }
    function main(): i32 {
      return identity("wrong");
    }
  `;
  assert.throws(
    () => compileToC(source, "arguments.z"),
    /arguments\.z:6:23: error: expected i32, found cstring/,
  );
});

test("infers primitive local types for C emission", () => {
  const source = `
    function answer(): i32 {
      return 42;
    }
    function main(): i32 {
      const value = answer();
      return value;
    }
  `;
  const generated = compileToC(source, "inference.z");
  assert.match(generated, /const int32_t value = answer\(\);/);
});

test("compiles boolean expressions and path-complete if statements", () => {
  const example = resolve(projectRoot, "examples/control-flow.z");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "disabled=0\nordinary=1\nspecial=2\n");
});

test("runs deterministic deinit across normal, return, throw, and try exits", () => {
  const example = resolve(projectRoot, "examples/deinit.z");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    "scope\ndeinit=2\ndeinit=1\ndeinit=3\ndeinit=5\ndeinit=4\ndeinit=8\ndeinit=9\ndeinit=10\ndeinit=11\ndeinit=13\ndeinit=12\ndeinit=14\ndeinit=15\ndeinit=16\ndeinit=17\ndeinit=18\ndeinit=18\ndeinit=19\ndeinit=19\ndeinit=6\ndeinit=7\n",
  );
});

test("rejects using a cleanup-bearing value after it moves", () => {
  const source = `
    struct Resource {
      id: i32;
      deinit {}
    }
    function main(): i32 {
      const first = Resource { id: 1 };
      const second = first;
      return first.id + second.id;
    }
  `;
  assert.throws(
    () => compileToC(source, "owned-copy.z"),
    /use of moved value "first"/,
  );
});

test("rejects values that may have moved on another branch", () => {
  const source = `
    struct Resource {
      id: i32;
      deinit {}
    }
    function consume(resource: Resource): i32 { return resource.id; }
    function choose(flag: bool): i32 {
      const resource = Resource { id: 1 };
      if (flag) {
        consume(resource);
      }
      return resource.id;
    }
    function main(): i32 { return choose(false); }
  `;
  assert.throws(
    () => compileToC(source, "maybe-moved.z"),
    /value "resource" may have been moved on another control-flow path/,
  );
});

test("merges ownership state across exhaustive match arms", () => {
  const source = `
    struct Resource {
      id: i32;
      deinit {}
    }
    enum Choice { move i32, keep i32, }
    function consume(resource: Resource): i32 { return resource.id; }
    function choose(choice: Choice, resource: Resource): i32 {
      match choice {
        move value => consume(resource);
        keep value => value;
      }
      return resource.id;
    }
    function main(): i32 {
      return choose(Choice.keep 1, Resource { id: 2 });
    }
  `;
  assert.throws(
    () => compileToC(source, "match-moved.z"),
    /value "resource" may have been moved on another control-flow path/,
  );
});

test("rejects discarding cleanup-bearing return values", () => {
  const source = `
    struct Resource {
      id: i32;
      deinit {}
    }
    function make(): Resource { return Resource { id: 1 }; }
    function main(): i32 {
      make();
      return 0;
    }
  `;
  assert.throws(
    () => compileToC(source, "owned-discard.z"),
    /a cleanup-bearing value must be bound or transferred; it cannot be discarded/,
  );
});

test("keeps deinit synchronous and free of explicit control-flow exits", () => {
  const source = `
    struct Resource {
      id: i32;
      deinit { return; }
    }
    function main(): i32 { return 0; }
  `;
  assert.throws(
    () => compileToC(source, "deinit-return.z"),
    /deinit cannot contain "return"/,
  );
});

test("requires boolean if conditions", () => {
  const source = `
    function main(): i32 {
      if (42) { return 1; } else { return 0; }
    }
  `;
  assert.throws(
    () => compileToC(source, "if-condition.z"),
    /if-condition\.z:3:11: error: expected bool, found i32/,
  );
});

test("requires every reachable if path to return", () => {
  const source = `
    function choose(flag: bool): i32 {
      if (flag) { return 1; }
    }
    function main(): i32 { return choose(true); }
  `;
  assert.throws(
    () => compileToC(source, "if-return.z"),
    /function "choose" must end with a return value/,
  );
});

test("rejects statements after every branch exits", () => {
  const source = `
    function choose(flag: bool): i32 {
      if (flag) { return 1; } else { return 2; }
      return 3;
    }
    function main(): i32 { return choose(true); }
  `;
  assert.throws(
    () => compileToC(source, "unreachable.z"),
    /unreachable\.z:4:7: error: unreachable statement after guaranteed function exit/,
  );
});

test("checks logical operand types", () => {
  const source = `
    function main(): i32 {
      const invalid = true && 1;
      return 0;
    }
  `;
  assert.throws(
    () => compileToC(source, "logical-types.z"),
    /operator "&&" requires bool operands/,
  );
});

test("emits struct layouts, literals, fields, and borrowed methods", () => {
  const source = `
    struct Point {
      x: i32;
      y: i32;
      function sum(): i32 {
        return this.x + this.y;
      }
    }
    function main(): i32 {
      const point = Point { x: 20, y: 22 };
      return point.sum();
    }
  `;
  const generated = compileToC(source, "point.z");
  assert.match(generated, /struct Z_Point \{/);
  assert.match(generated, /static int32_t Z_Point_sum\(const Z_Point \*self\)/);
  assert.match(generated, /const Z_Point point = \(Z_Point\)\{ \.x = 20, \.y = 22 \};/);
  assert.match(generated, /return Z_Point_sum\(&\(point\)\);/);
});

test("requires every struct field exactly once", () => {
  const source = `
    struct Point {
      x: i32;
      y: i32;
    }
    function main(): i32 {
      const point = Point { x: 1 };
      return point.x;
    }
  `;
  assert.throws(
    () => compileToC(source, "missing-field.z"),
    /missing-field\.z:7:21: error: missing field "y" when constructing "Point"/,
  );
});

test("checks struct method arguments", () => {
  const source = `
    struct Counter {
      value: i32;
      function add(amount: i32): i32 {
        return this.value + amount;
      }
    }
    function main(): i32 {
      const counter = Counter { value: 1 };
      return counter.add("wrong");
    }
  `;
  assert.throws(
    () => compileToC(source, "method-arguments.z"),
    /method-arguments\.z:10:26: error: expected i32, found cstring/,
  );
});

test("requires exhaustive enum matches", () => {
  const source = `
    enum Outcome {
      success i32,
      failure i32,
    }
    function main(): i32 {
      const outcome = Outcome.success 42;
      match outcome {
        success value => return value;
      }
    }
  `;
  assert.throws(
    () => compileToC(source, "exhaustive.z"),
    /exhaustive\.z:8:7: error: non-exhaustive match; missing Outcome\.failure/,
  );
});

test("compiles payload enums and exhaustive matches", () => {
  const example = resolve(projectRoot, "examples/match.z");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "matched=42\n");
});

test("compiles expression matches with concise and yielding block arms", () => {
  const example = resolve(projectRoot, "examples/match-expression.z");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "code=41\ndirect=41\nyielded=42\n");
});

test("requires yield to target a value-producing block", () => {
  const source = `
    function main(): i32 {
      yield 42;
      return 0;
    }
  `;
  assert.throws(
    () => compileToC(source, "orphan-yield.z"),
    /orphan-yield\.z:3:7: error: yield requires an enclosing value-producing block/,
  );
});

test("requires expression match arms to agree on a value type", () => {
  const source = `
    enum Choice { first i32, second i32, }
    function main(): i32 {
      const choice = Choice.first 42;
      const value = match choice {
        first number => number;
        second number => "wrong";
      };
      return value;
    }
  `;
  assert.throws(
    () => compileToC(source, "match-types.z"),
    /match-types\.z:7:9: error: match arm produces cstring, but previous arms produce i32/,
  );
});

test("requires explicit handling for throwing calls", () => {
  const source = `
    struct Problem { code: i32; }
    function fallible(): i32 throws Problem { return 42; }
    function main(): i32 { return fallible(); }
  `;
  assert.throws(
    () => compileToC(source, "explicit-errors.z"),
    /throwing call requires `attempt` or `try`/,
  );
});

test("rejects throw outside a throwing function", () => {
  const source = `
    struct Problem { code: i32; }
    function main(): i32 { throw Problem { code: 1 }; }
  `;
  assert.throws(
    () => compileToC(source, "invalid-throw.z"),
    /function "main" does not declare an error type/,
  );
});

test("compiles typed Result success and failure paths", () => {
  const example = resolve(projectRoot, "examples/result.z");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "found=42\nerror=7\n");
});

test("requires try inside a throwing function", () => {
  const source = `
    struct Problem { code: i32; }
    function fallible(): i32 throws Problem { return 42; }
    function main(): i32 { return try fallible(); }
  `;
  assert.throws(
    () => compileToC(source, "try-context.z"),
    /try requires an enclosing throwing function/,
  );
});

test("requires compatible propagated error types", () => {
  const source = `
    struct FirstError { code: i32; }
    struct SecondError { code: i32; }
    function first(): i32 throws FirstError { return 1; }
    function second(): i32 throws SecondError {
      const value = try first();
      return value;
    }
    function main(): i32 { return 0; }
  `;
  assert.throws(
    () => compileToC(source, "try-errors.z"),
    /cannot propagate FirstError from a function throwing SecondError/,
  );
});

test("propagates typed failures through try", () => {
  const example = resolve(projectRoot, "examples/try.z");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "id=42\nforwarded=9\nerror=7\n");
});

test("compiles and runs structs as native values", () => {
  const example = resolve(projectRoot, "examples/structs.z");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "original=42 translated=45\n");
});

test("assigns mutable locals and nested value fields", () => {
  const example = resolve(projectRoot, "examples/mutation.z");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "count=2 point=40,2 frame=40,2/640\n");

  const generated = compileToC(readFileSync(example, "utf8"), example);
  assert.match(generated, /count = \(count \+ 1\);/);
  assert.match(generated, /\(point\)\.x = 40;/);
  assert.match(generated, /point = \(Z_Point\)\{ \.x = \(point\)\.x, \.y = count \};/);
  assert.match(generated, /\(\(frame\)\.origin\)\.y = 2;/);
});

test("runs explicit mutable receivers while immutable methods remain borrowable", () => {
  const example = resolve(projectRoot, "examples/mutable-methods.z");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "counter=3 snapshot=3 nested=15 temporary=7\n");

  const generated = compileToC(readFileSync(example, "utf8"), example);
  assert.match(generated, /static void Z_Counter_add\(Z_Counter \*self, int32_t amount\)/);
  assert.match(generated, /static int32_t Z_Counter_current\(const Z_Counter \*self\)/);
  assert.match(generated, /static void Z_Panel_bump\(Z_Panel \*self, int32_t amount\)/);
  assert.match(generated, /Z_Counter_add\(&\(counter\), 2\);/);
  assert.match(generated, /Z_Counter_add\(&\(self->counter\), amount\);/);
});

test("requires addressable mutable storage for inout method receivers", () => {
  const immutable = `
    struct Counter {
      value: i32;
      function add(inout this, amount: i32): void {
        this.value = this.value + amount;
      }
    }
    function main(): i32 {
      const counter = Counter { value: 1 };
      counter.add(2);
      return 0;
    }
  `;
  assert.throws(
    () => compileToC(immutable, "immutable-receiver.z"),
    /mutable method "add" cannot be called through immutable binding "counter"/,
  );

  const temporary = immutable.replace(
    "const counter = Counter { value: 1 };\n      counter.add(2);",
    "Counter { value: 1 }.add(2);",
  );
  assert.throws(
    () => compileToC(temporary, "temporary-receiver.z"),
    /mutable method "add" requires addressable let storage/,
  );

  const transitive = `
    struct Counter {
      value: i32;
      function add(inout this, amount: i32): void {
        this.value = this.value + amount;
      }
    }
    struct Panel {
      counter: Counter;
      function invalid(): void {
        this.counter.add(1);
      }
    }
    function main(): i32 { return 0; }
  `;
  assert.throws(
    () => compileToC(transitive, "transitive-receiver.z"),
    /mutable method "add" cannot be called through immutable binding "this"/,
  );
});

test("keeps receiver capabilities in method signatures", () => {
  const topLevelReceiver = `
    function invalid(inout this): void {}
    function main(): i32 { return 0; }
  `;
  assert.throws(
    () => compileToC(topLevelReceiver, "top-level-receiver.z"),
    /`inout this` is only valid on a struct method/,
  );

  const topLevelMoveReceiver = `
    function invalid(move this): void {}
    function main(): i32 { return 0; }
  `;
  assert.throws(
    () => compileToC(topLevelMoveReceiver, "top-level-move-receiver.z"),
    /`move this` is only valid on a struct method/,
  );

  const movedReceiver = `
    struct Resource {
      value: i32;
      function merge(inout this, other: Resource): void {}
      deinit {}
    }
    function main(): i32 {
      let resource = Resource { value: 1 };
      resource.merge(resource);
      return 0;
    }
  `;
  assert.throws(
    () => compileToC(movedReceiver, "moved-receiver.z"),
    /overlapping inout and value uses of "resource" in one call are not allowed/,
  );
});

test("moves consuming receivers and cleans them up exactly once", () => {
  const example = resolve(projectRoot, "examples/consuming-methods.z");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "drop=42\nresult=42 copy=7,7\n");

  const generated = compileToC(readFileSync(example, "utf8"), example);
  assert.match(generated, /static Z_Resource Z_Resource_relay\(Z_Resource self\)/);
  assert.match(generated, /static int32_t Z_Resource_finish\(Z_Resource self, int32_t offset\)/);
  assert.match(generated, /self\.id = \(self\.id \+ offset\);/);
  assert.match(generated, /Z_Resource_relay\(\(_z_live_first_\d+ = false, first\)\)/);
  assert.match(generated, /Z_Resource_finish\(\(_z_live_second_\d+ = false, second\), 2\)/);

  const useAfterConsume = `
    struct Resource {
      id: i32;
      function finish(move this): void {}
      deinit {}
    }
    function main(): i32 {
      const resource = Resource { id: 1 };
      resource.finish();
      return resource.id;
    }
  `;
  assert.throws(
    () => compileToC(useAfterConsume, "use-after-consuming-method.z"),
    /use of moved value "resource"/,
  );

  const borrowedConsume = `
    struct Resource {
      id: i32;
      function finish(move this): void {}
      function invalid(): void { this.finish(); }
      deinit {}
    }
    function main(): i32 { return 0; }
  `;
  assert.throws(
    () => compileToC(borrowedConsume, "consume-borrowed-receiver.z"),
    /cannot move the borrowed method receiver `this`; declare `move this`/,
  );

  const overlappingConsume = `
    struct Resource {
      id: i32;
      function merge(move this, in other: Resource): void {}
      deinit {}
    }
    function main(): i32 {
      const resource = Resource { id: 1 };
      resource.merge(resource);
      return 0;
    }
  `;
  assert.throws(
    () => compileToC(overlappingConsume, "overlapping-consuming-receiver.z"),
    /overlapping move and in uses of "resource" in one call are not allowed/,
  );
});

test("borrows native parameters immutably and mutably", () => {
  const example = resolve(projectRoot, "examples/borrowed-parameters.z");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "counter=16 literal=7 resource=42\ndrop=42\n");

  const generated = compileToC(readFileSync(example, "utf8"), example);
  assert.match(generated, /static int32_t read\(const Z_Counter \*counter\)/);
  assert.match(generated, /static void add\(Z_Counter \*counter, int32_t amount\)/);
  assert.match(generated, /static int32_t inspect\(const Z_Resource \*resource\)/);
  assert.match(generated, /add\(counter, 2\);/);
  assert.match(generated, /add\(self, 1\);/);
  assert.match(generated, /read\(&\(counter\)\)/);
  assert.doesNotMatch(generated, /Z_Resource_deinit\(&\(\*resource\)\)/);
});

test("enforces native parameter capabilities at declaration and call sites", () => {
  const missingInout = `
    function increment(inout value: i32): void {
      value = value + 1;
    }
    function main(): i32 {
      let value = 1;
      increment(value);
      return value;
    }
  `;
  assert.throws(
    () => compileToC(missingInout, "missing-native-inout.z"),
    /"increment" requires inout <mutable binding> for parameter 1/,
  );

  const immutableInout = missingInout
    .replace("let value = 1", "const value = 1")
    .replace("increment(value)", "increment(inout value)");
  assert.throws(
    () => compileToC(immutableInout, "immutable-native-inout.z"),
    /inout argument "value" requires a mutable let binding/,
  );

  const overlapping = `
    function invalid(inout first: i32, inout second: i32): void {}
    function main(): i32 {
      let value = 1;
      invalid(inout value, inout value);
      return value;
    }
  `;
  assert.throws(
    () => compileToC(overlapping, "overlapping-inout.z"),
    /overlapping inout and inout uses of "value" in one call are not allowed/,
  );

  const mutateInput = `
    function invalid(in value: i32): void {
      value = 2;
    }
    function main(): i32 {
      const value = 1;
      invalid(value);
      return value;
    }
  `;
  assert.throws(
    () => compileToC(mutateInput, "mutate-input.z"),
    /cannot assign to immutable binding "value"/,
  );

  const legacyTypePosition = `
    function inspect(value: in i32): void {}
    function main(): i32 { return 0; }
  `;
  assert.throws(
    () => compileToC(legacyTypePosition, "legacy-capability-order.z"),
    /expected a type name, found "in"/,
  );
});

test("initializes native out parameters with flow-sensitive checking", () => {
  const example = resolve(projectRoot, "examples/native-out.z");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    "17/5=3 remainder=2\nselected=10\nstatus=7 value=42\ninit=40\ndrop=40\ninit=42\nresource=42\ndrop=42\n",
  );

  const generated = compileToC(readFileSync(example, "utf8"), example);
  assert.match(generated, /static void divide\(int32_t value, int32_t divisor, int32_t \*quotient, int32_t \*remainder\)/);
  assert.match(generated, /int32_t quotient;\n\s+int32_t remainder;/);
  assert.match(generated, /divide\(17, 5, &\(quotient\), &\(remainder\)\);/);
  assert.match(generated, /const int32_t _z_out_result_\d+ = initializeWithStatus\(&\(statusValue\)\);\n\s+const int32_t status = _z_out_result_\d+;/);
  assert.match(generated, /Z_Resource resource;\n\s+bool (_z_live_resource_\d+) = false;/);
  assert.match(generated, /if \(_z_live_resource_\d+\) Z_Resource_deinit\(&\(resource\)\);\n\s+_z_live_resource_\d+ = false;\n\s+makeResource\(40, &\(resource\)\);\n\s+_z_live_resource_\d+ = true;/);

  const readBeforeInitialization = `
    function main(): i32 {
      let value: i32;
      return value;
    }
  `;
  assert.throws(
    () => compileToC(readBeforeInitialization, "read-uninitialized.z"),
    /use of uninitialized value "value"/,
  );

  const maybeInitialized = `
    function main(): i32 {
      let value: i32;
      if (true) { value = 1; }
      return value;
    }
  `;
  assert.throws(
    () => compileToC(maybeInitialized, "maybe-uninitialized.z"),
    /value "value" may be uninitialized on another control-flow path/,
  );

  const missingOutput = `
    function initialize(flag: bool, out value: i32): void {
      if (flag) { value = 1; }
    }
    function main(): i32 { return 0; }
  `;
  assert.throws(
    () => compileToC(missingOutput, "missing-out-initialization.z"),
    /out parameter "value" may be uninitialized on a successful return path/,
  );

  const missingModifier = `
    function initialize(out value: i32): void { value = 1; }
    function main(): i32 {
      let value: i32;
      initialize(value);
      return value;
    }
  `;
  assert.throws(
    () => compileToC(missingModifier, "missing-out-call-modifier.z"),
    /"initialize" requires out <mutable binding> for parameter 1/,
  );

  const immutableOutput = `
    function initialize(out value: i32): void { value = 1; }
    function main(): i32 {
      const value = 0;
      initialize(out value);
      return value;
    }
  `;
  assert.throws(
    () => compileToC(immutableOutput, "immutable-out.z"),
    /out argument "value" requires a mutable let binding/,
  );

  const uninitializedInout = `
    function update(inout value: i32): void { value = value + 1; }
    function main(): i32 {
      let value: i32;
      update(inout value);
      return 0;
    }
  `;
  assert.throws(
    () => compileToC(uninitializedInout, "uninitialized-inout.z"),
    /inout argument "value" must be initialized before the call/,
  );

  const throwingOutput = `
    enum Failure { invalid, }
    function initialize(out value: i32): i32 throws Failure {
      value = 1;
      return value;
    }
    function main(): i32 { return 0; }
  `;
  assert.throws(
    () => compileToC(throwingOutput, "throwing-out.z"),
    /throwing functions with out parameters are not implemented yet/,
  );

  assert.throws(
    () => compileToC("function main(): i32 { let value; return 0; }", "untyped-uninitialized.z"),
    /an uninitialized let declaration requires a type annotation/,
  );
  assert.throws(
    () => compileToC("function main(): i32 { const value: i32; return 0; }", "uninitialized-const.z"),
    /const declarations require an initializer/,
  );
});

test("borrowed cleanup values cannot be consumed", () => {
  const source = `
    struct Resource {
      id: i32;
      deinit {}
    }
    function invalid(in resource: Resource): Resource {
      return resource;
    }
    function main(): i32 { return 0; }
  `;
  assert.throws(
    () => compileToC(source, "move-borrowed-parameter.z"),
    /cannot move borrowed parameter "resource"/,
  );
});

test("keeps const values, parameters, and borrowed receivers immutable", () => {
  const immutableLocal = `
    function main(): i32 {
      const value = 1;
      value = 2;
      return value;
    }
  `;
  assert.throws(
    () => compileToC(immutableLocal, "const-assignment.z"),
    /cannot assign to immutable binding "value"/,
  );

  const immutableField = `
    struct Point { x: i32; }
    function main(): i32 {
      const point = Point { x: 1 };
      point.x = 2;
      return point.x;
    }
  `;
  assert.throws(
    () => compileToC(immutableField, "const-field-assignment.z"),
    /cannot mutate a field through immutable binding "point"/,
  );

  const immutableParameter = `
    function change(value: i32): i32 {
      value = 2;
      return value;
    }
    function main(): i32 { return change(1); }
  `;
  assert.throws(
    () => compileToC(immutableParameter, "parameter-assignment.z"),
    /cannot assign to immutable binding "value"/,
  );

  const borrowedReceiver = `
    struct Counter {
      value: i32;
      function change(): i32 {
        this.value = 2;
        return this.value;
      }
    }
    function main(): i32 { return 0; }
  `;
  assert.throws(
    () => compileToC(borrowedReceiver, "receiver-assignment.z"),
    /cannot mutate a field through immutable binding "this"/,
  );
});

test("type-checks assignments and replaces cleanup-bearing values safely", () => {
  const wrongType = `
    function main(): i32 {
      let value = 1;
      value = true;
      return value;
    }
  `;
  assert.throws(
    () => compileToC(wrongType, "assignment-type.z"),
    /expected i32, found bool/,
  );

  const example = resolve(projectRoot, "examples/replacement.z");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "make=2\ndrop=1\nlive=5\ndrop=10\nholder=20\ndrop=20\ndrop=5\n");

  const generated = compileToC(readFileSync(example, "utf8"), example);
  assert.match(generated, /_z_replacement_\d+ = make\(2\);\n\s+if \(_z_live_resource_\d+\) Z_Resource_deinit\(&\(resource\)\);/);
  assert.match(generated, /_z_replacement_\d+ = Z_Resource_bumped\(\(_z_live_resource_\d+ = false, resource\), 3\);/);
  assert.match(generated, /resource = _z_replacement_\d+;\n\s+_z_live_resource_\d+ = true;/);
  assert.match(generated, /Z_Resource_deinit\(&\(\(holder\)\.resource\)\);\n\s+\(holder\)\.resource = _z_replacement_\d+;/);
});

test("compiles and runs the first native program", () => {
  const example = resolve(projectRoot, "examples/first.z");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Z says 42\n");
});

function dirnameFromImportMeta(): string {
  return new URL(".", import.meta.url).pathname;
}

test("editor grammar tracks keywords without reserving Result variants", () => {
  const grammarPath = resolve(projectRoot, "editors/vscode/syntaxes/z.tmLanguage.json");
  const grammar = JSON.parse(readFileSync(grammarPath, "utf8"));
  const keywordPattern = grammar.repository.keywords.patterns.map((pattern: { match: string }) => pattern.match).join(" ");
  const constantPattern = grammar.repository.constants.patterns.map((pattern: { match: string }) => pattern.match).join(" ");
  const operatorPattern = grammar.repository.operators.patterns.map((pattern: { match: string }) => pattern.match).join(" ");
  assert.match(keywordPattern, /throw/);
  assert.match(keywordPattern, /attempt/);
  assert.match(keywordPattern, /yield/);
  assert.match(keywordPattern, /deinit/);
  assert.match(keywordPattern, /out\|inout/);
  assert.match(keywordPattern, /\bin\b/);
  assert.match(keywordPattern, /\bas\b/);
  assert.match(constantPattern, /true\|false/);
  assert.match(constantPattern, /null/);
  assert.match(constantPattern, /this/);
  assert.match(operatorPattern, /&&/);
  assert.match(operatorPattern, /<</);
  assert.match(operatorPattern, /\^/);
  assert.match(operatorPattern, /=/);
  assert.doesNotMatch(keywordPattern, /success|failure/);
});
