import { test, expect } from "bun:test";
import { compileToC } from "../compiler/src/compiler.ts";
import { expectedChecksum, isolateBenchmarkKernel, median, removeBenchmarkBounds } from "../benchmarks/checked-indexing.ts";

test("opaque benchmark kernel transformation changes only its two linkage prefixes", () => {
  for (const prefix of ["Z_UNUSED_FUNCTION static", "static __attribute__((unused))"]) {
    const source = `${prefix} uint64_t registersView(State *state, uint64_t rounds);\n${prefix} uint64_t registersView(State *state, uint64_t rounds) { return 3; }`;
    expect(isolateBenchmarkKernel(source, "registers-view")).toBe(source.replaceAll(prefix, "__attribute__((noinline))"));
  }
  expect(() => isolateBenchmarkKernel("", "linear")).toThrow("found 0");
  expect(() => isolateBenchmarkKernel("", "unknown")).toThrow("unknown kernel");
});

test("bounds experiment changes only the known Stage 0 index helper", () => {
  const source = compileToC(`function main(): i32 {
    let values = Array<i32>(4);
    let index: usize = 0;
    index = index + 1;
    return values[index];
  }`, "index-experiment.zs");
  const experiment = removeBenchmarkBounds(source, "stage0");
  expect(experiment.removed).toEqual(["z_bounds_index"]);
  expect(experiment.source).toBe(source.replace("if (index >= length) abort();", "(void)length; /* benchmark-only: valid indices */"));
  expect(experiment.source).toContain("__builtin_add_overflow");
  expect(experiment.source).toContain("if (storage == NULL) abort();");
  expect(() => removeBenchmarkBounds(experiment.source, "stage0")).toThrow("found 0");
  expect(() => removeBenchmarkBounds(source + source, "stage0")).toThrow("found 2");
});

test("native bounds experiment leaves Slice, overflow, and unrelated guards intact", () => {
  const functions = ["u64", "usize"].flatMap(type => ["at", "at_mut"].map(method =>
    `static inline __attribute__((unused)) uint64_t *Z___z_Array_${type}_${method}(Z___z_Array_${type} *self, size_t index) {\n  if (index >= self->length) abort();\n  return &((uint64_t *)self->data)[index];\n}`));
  const other = `
static inline __attribute__((unused)) uint64_t *Z___z_Slice_u64_at(Z___z_Slice_u64 *self, size_t index) {
  if (index >= self->length) abort();
  return &((uint64_t *)self->data)[index];
}
if (__builtin_add_overflow(left, right, &result)) abort();
if (storage == NULL) abort();
`;
  const experiment = removeBenchmarkBounds(functions.join("\n") + other, "native");
  expect(experiment.removed).toHaveLength(4);
  expect(experiment.source.endsWith(other)).toBe(true);
  expect(() => removeBenchmarkBounds(functions[0]! + other, "native")).toThrow("found 1");
  expect(() => removeBenchmarkBounds(functions.join("\n").replaceAll("size_t index", "uintptr_t index"), "native")).toThrow("found 0");
});

test("benchmark statistics and independent wrapping oracle are deterministic", () => {
  expect(median([3, 1, 2])).toBe(2);
  expect(median([1, 4, 3, 2])).toBe(2.5);
  expect(() => median([])).toThrow();
  for (const kernel of ["linear", "indirect", "registers-direct", "registers-view"]) expect(expectedChecksum(kernel, 1, 3)).toBe("0");
  expect(expectedChecksum("registers-direct", 257, 3)).toBe(expectedChecksum("registers-view", 257, 3));
  expect(expectedChecksum("indirect", 17, 3)).not.toBe(expectedChecksum("linear", 17, 3));
});
