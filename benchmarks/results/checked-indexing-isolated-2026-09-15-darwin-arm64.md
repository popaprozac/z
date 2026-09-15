# Checked-indexing checkpoint

2026-09-15T22:42:01.199Z

Compiler 684ce9803a5a8185753b88764dc7f2207b74c9bb; worktree dirty: true. Apple M4 Pro; darwin 25.4.0 arm64.

4096 elements × 32768 rounds (134217728 operations), 2 warmups, 9 samples per variant.

Kernel clock time only. Setup, allocation, cleanup, compilation and process startup excluded. Data-dependent wrapping checksum prevents loop folding. Identical Clang profiles; bounds-removed variants change only array indexing guards and are valid-input experiments, not safe programs on arbitrary inputs. UBSan and independent BigInt oracle validate small inputs; checked C validates measured checksums. No allocation counts or engine-speed claims. Opaque-function control: selected kernel declaration/definition made externally visible and noinline in generated C and the C reference, preventing caller-specific inlining/specialization. This is not default Z codegen or a proposed public attribute.

Medians (min–max) in milliseconds. Negative reduction means the experimental variant was slower; small differences need repeated runs.

| Kernel | Profile | Emitter | Checked | Bounds removed | Median reduction |
| --- | --- | --- | ---: | ---: | ---: |
| linear | O2 | c | 102.348 (101.793–107.739) | 105.342 (101.811–117.534) | -2.9% |
| linear | O2 | stage0 | 104.223 (101.792–106.953) | 105.087 (101.823–112.253) | -0.8% |
| linear | O2 | native | 104.248 (102.284–147.759) | 104.157 (101.887–107.105) | 0.1% |
| linear | O3 | c | 104.305 (102.989–112.257) | 107.561 (102.882–140.458) | -3.1% |
| linear | O3 | stage0 | 106.113 (103.093–115.010) | 104.158 (102.864–115.879) | 1.8% |
| linear | O3 | native | 106.379 (102.893–112.483) | 105.144 (102.657–131.733) | 1.2% |
| indirect | O2 | c | 102.700 (102.088–107.010) | 102.981 (101.879–106.498) | -0.3% |
| indirect | O2 | stage0 | 103.102 (101.959–110.401) | 102.421 (101.641–107.413) | 0.7% |
| indirect | O2 | native | 104.991 (101.983–108.826) | 102.835 (101.619–105.666) | 2.1% |
| indirect | O3 | c | 102.488 (101.970–109.376) | 104.172 (101.989–149.971) | -1.6% |
| indirect | O3 | stage0 | 102.916 (102.144–106.010) | 102.528 (101.854–126.862) | 0.4% |
| indirect | O3 | native | 103.340 (102.355–106.919) | 102.994 (102.371–106.127) | 0.3% |
| registers-direct | O2 | c | 48.740 (47.409–53.389) | 45.803 (45.461–47.770) | 6.0% |
| registers-direct | O2 | stage0 | 50.122 (46.866–53.013) | 45.774 (45.359–50.301) | 8.7% |
| registers-direct | O2 | native | 68.951 (68.457–72.584) | 45.687 (45.385–47.133) | 33.7% |
| registers-direct | O3 | c | 50.400 (49.144–51.988) | 46.024 (45.746–47.300) | 8.7% |
| registers-direct | O3 | stage0 | 49.951 (48.454–52.528) | 46.358 (45.843–48.915) | 7.2% |
| registers-direct | O3 | native | 69.764 (68.969–71.264) | 46.113 (45.522–48.225) | 33.9% |
| registers-view | O2 | c | 48.729 (47.852–51.546) | 45.824 (45.457–50.698) | 6.0% |
| registers-view | O2 | stage0 | 49.840 (47.433–51.772) | 45.773 (45.127–47.665) | 8.2% |
| registers-view | O2 | native | 68.854 (68.398–72.116) | 45.741 (45.168–49.035) | 33.6% |
| registers-view | O3 | c | 49.438 (48.628–52.981) | 46.551 (46.148–51.046) | 5.8% |
| registers-view | O3 | stage0 | 49.613 (47.906–51.257) | 46.294 (46.018–46.752) | 6.7% |
| registers-view | O3 | native | 69.289 (68.704–72.725) | 46.526 (45.893–48.798) | 32.9% |

Raw samples, toolchain, checksums, exact source hashes, changed helper names and compilation observations are in the adjacent JSON. Generated C, optimized LLVM IR and assembly remain under `benchmarks/.build/checked-indexing/run-B08rh1`. Native rows use the bootstrapped driver, including imported-header metadata. The adjacent bootstrap C is verified against current self-emission; binary and source hashes are recorded. Single emission/build timings are observations, not a comparative compiler-speed result.
