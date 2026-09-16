# Checked-indexing checkpoint

2026-09-16T00:08:41.415Z

Compiler db73fb6cc5472a14a1ed1194cf00571ef01d6a14; worktree dirty: false. Apple M4 Pro; darwin 25.4.0 arm64.

4096 elements × 32768 rounds (134217728 operations), 2 warmups, 9 samples per variant.

Kernel clock time only. Setup, allocation, cleanup, compilation and process startup excluded. Data-dependent wrapping checksum prevents loop folding. Identical Clang profiles; bounds-removed variants change only array indexing guards and are valid-input experiments, not safe programs on arbitrary inputs. UBSan and independent BigInt oracle validate small inputs; checked C validates measured checksums. No allocation counts or engine-speed claims. Opaque-function control: selected kernel declaration/definition made externally visible and noinline in generated C and the C reference, preventing caller-specific inlining/specialization. This is not default Z codegen or a proposed public attribute.

Medians (min–max) in milliseconds. Negative reduction means the experimental variant was slower; small differences need repeated runs.

| Kernel | Profile | Emitter | Checked | Bounds removed | Median reduction |
| --- | --- | --- | ---: | ---: | ---: |
| linear | O2 | c | 98.144 (96.207–99.280) | 98.656 (97.358–100.487) | -0.5% |
| linear | O2 | stage0 | 98.482 (96.626–101.903) | 98.492 (96.335–100.122) | -0.0% |
| linear | O2 | native | 98.623 (96.184–99.488) | 98.268 (96.804–99.871) | 0.4% |
| linear | O3 | c | 97.887 (95.483–98.814) | 97.816 (96.816–99.328) | 0.1% |
| linear | O3 | stage0 | 97.844 (97.335–98.462) | 97.843 (96.039–98.887) | 0.0% |
| linear | O3 | native | 98.172 (96.275–99.134) | 98.314 (97.593–98.502) | -0.1% |
| indirect | O2 | c | 100.165 (98.944–102.742) | 98.268 (97.344–100.233) | 1.9% |
| indirect | O2 | stage0 | 100.359 (99.278–102.300) | 99.091 (96.674–100.891) | 1.3% |
| indirect | O2 | native | 100.152 (99.483–101.676) | 98.847 (96.768–102.221) | 1.3% |
| indirect | O3 | c | 99.599 (98.307–101.180) | 98.517 (97.052–99.629) | 1.1% |
| indirect | O3 | stage0 | 100.733 (98.083–115.474) | 98.752 (97.834–155.000) | 2.0% |
| indirect | O3 | native | 100.330 (99.648–120.349) | 97.887 (96.967–99.018) | 2.4% |
| registers-direct | O2 | c | 49.477 (47.676–53.444) | 46.185 (45.169–46.841) | 6.7% |
| registers-direct | O2 | stage0 | 50.380 (48.086–52.274) | 46.228 (45.204–47.246) | 8.2% |
| registers-direct | O2 | native | 48.907 (47.706–51.879) | 46.291 (45.273–48.444) | 5.3% |
| registers-direct | O3 | c | 50.015 (48.337–52.992) | 46.374 (45.630–47.349) | 7.3% |
| registers-direct | O3 | stage0 | 50.455 (48.970–52.877) | 46.746 (45.811–46.907) | 7.4% |
| registers-direct | O3 | native | 50.168 (48.705–74.434) | 46.387 (45.850–47.383) | 7.5% |
| registers-view | O2 | c | 49.248 (47.935–53.887) | 46.436 (45.501–47.011) | 5.7% |
| registers-view | O2 | stage0 | 48.863 (47.734–53.262) | 46.345 (45.614–46.790) | 5.2% |
| registers-view | O2 | native | 49.188 (48.289–53.327) | 46.068 (45.658–46.722) | 6.3% |
| registers-view | O3 | c | 50.757 (49.212–53.364) | 46.742 (45.740–51.638) | 7.9% |
| registers-view | O3 | stage0 | 50.166 (48.804–52.992) | 46.497 (45.622–47.637) | 7.3% |
| registers-view | O3 | native | 50.453 (48.384–51.005) | 45.871 (45.457–47.754) | 9.1% |

Raw samples, toolchain, checksums, exact source hashes, changed helper names and compilation observations are in the adjacent JSON. Generated C, optimized LLVM IR and assembly remain under `benchmarks/.build/checked-indexing/run-6QZsp1`. Native rows use the bootstrapped driver, including imported-header metadata. The adjacent bootstrap C is verified against current self-emission; binary and source hashes are recorded. Single emission/build timings are observations, not a comparative compiler-speed result.
