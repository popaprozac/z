// Bounds-only experiments on valid synthetic inputs. Never a release profile.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { arch, cpus, platform, release } from "node:os";
import { dirname, relative, resolve } from "node:path";

type Emitter = "stage0" | "native";
export function isolateBenchmarkKernel(source: string, kernel: string) {
  const names: Record<string, string> = { linear: "linear", indirect: "indirect", "registers-direct": "registersDirect", "registers-view": "registersView" };
  const name = names[kernel];
  if (!name) throw new Error(`unknown kernel ${kernel}`);
  const pattern = new RegExp(`^(?:Z_UNUSED_FUNCTION static|static __attribute__\\(\\(unused\\)\\)) uint64_t ((?:__z_module_\\d+_)?${name})\\(`, "gm");
  let replacements = 0;
  const changed = source.replace(pattern, (_, symbol: string) => {
    replacements++;
    return `__attribute__((noinline)) uint64_t ${symbol}(`;
  });
  if (replacements !== 2) throw new Error(`expected kernel declaration and definition, found ${replacements}`);
  return changed;
}

export function removeBenchmarkBounds(source: string, emitter: Emitter) {
  const removed: string[] = [];
  let changed: string;
  if (emitter === "stage0") {
    const helper = "static Z_UNUSED_FUNCTION inline uintptr_t z_bounds_index(uintptr_t index, uintptr_t length) {\n  if (index >= length) abort();\n  return index;\n}";
    changed = source.replaceAll(helper, () => {
      removed.push("z_bounds_index");
      return helper.replace("if (index >= length) abort();", "(void)length; /* benchmark-only: valid indices */");
    });
  } else {
    changed = source.replace(
      /(^static inline __attribute__\(\(unused\)\) [^\n]+ \*(Z_\w*Array_\w+_at(?:_mut)?)\([^\n]*, size_t index\) \{\n)  if \(index >= self->length\) abort\(\);/gm,
      (_, header: string, name: string) => {
        removed.push(name);
        return header + "  /* benchmark-only: valid indices */";
      },
    );
  }
  // These fixtures have exactly two Array element types. Fail closed if the
  // emitter changes shape; never replace aborts, overflow or allocation checks.
  const expected = emitter === "stage0" ? 1 : 4;
  if (removed.length !== expected) throw new Error(`${emitter}: expected ${expected} known bounds helpers, found ${removed.length}`);
  return { source: changed, removed };
}

export function median(values: readonly number[]): number {
  const sorted = values.toSorted((a, b) => a - b);
  if (!sorted.length) throw new Error("median requires samples");
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export function expectedChecksum(kind: string, width: number, rounds: number): string {
  const mask = (1n << 64n) - 1n;
  const values = Array.from({ length: width }, (_, i) => {
    let v = BigInt(i);
    v = ((v ^ (v >> 30n)) * 0xbf58476d1ce4e5b9n) & mask;
    v = ((v ^ (v >> 27n)) * 0x94d049bb133111ebn) & mask;
    return v ^ (v >> 31n);
  });
  const registers = Array.from({ length: 256 }, (_, i) => BigInt(i));
  let checksum = 0n;
  for (let round = 0; round < rounds; ++round) for (const instruction of values) {
    if (kind === "linear") checksum = (checksum * 33n + instruction) & mask;
    else if (kind === "indirect") checksum = (checksum * 33n + values[Number(instruction % BigInt(width))]!) & mask;
    else if (kind === "registers-direct" || kind === "registers-view") {
      const value = (registers[Number((instruction >> 8n) & 255n)]! + (instruction >> 16n)) & mask;
      registers[Number(instruction & 255n)] = value;
      checksum = (checksum + value) & mask;
    } else throw new Error(`unknown kernel ${kind}`);
  }
  return String(checksum);
}

export async function main() {
  const root = resolve(import.meta.dir, "..");
  const cases = ["linear", "indirect", "registers-direct", "registers-view"];
  const inputs = resolve(root, "benchmarks/cases/checked-indexing");
  const native = resolve(process.env.Z_BENCH_NATIVE ?? resolve(root, ".z-cache/bootstrap/z"));
  if (!existsSync(native) || !existsSync(`${native}.c`)) throw new Error("Run bun run bootstrap before this benchmark (native binary and adjacent .c required).");
  function positive(name: string, fallback: number) {
    const n = Number(process.env[name] ?? fallback);
    if (!Number.isSafeInteger(n) || n < 1) throw new Error(`${name} must be a positive safe integer`);
    return n;
  }
  const width = positive("Z_INDEX_WIDTH", 4096);
  if (width > 1048576) throw new Error("Z_INDEX_WIDTH must not exceed 1048576");
  const rounds = positive("Z_INDEX_ROUNDS", 32768);
  if (!Number.isSafeInteger(width * rounds)) throw new Error("workload is too large");
  const samples = positive("Z_INDEX_SAMPLES", 9);
  const warmups = positive("Z_INDEX_WARMUPS", 2);
  const isolated = process.env.Z_INDEX_ISOLATE === "1";
  if (process.env.Z_INDEX_ISOLATE && !["0", "1"].includes(process.env.Z_INDEX_ISOLATE)) throw new Error("Z_INDEX_ISOLATE must be 0 or 1");
  const timeout = positive("Z_BENCH_TIMEOUT_MS", 180_000);
  const profiles = (process.env.Z_INDEX_PROFILES ?? "O2,O3").split(",");
  if (profiles.some(p => p !== "O2" && p !== "O3") || new Set(profiles).size !== profiles.length) throw new Error("Z_INDEX_PROFILES must select O2,O3 without duplicates");
  const base = resolve(root, "benchmarks/.build/checked-indexing");
  mkdirSync(base, { recursive: true });
  const work = mkdtempSync(resolve(base, "run-"));
  const children = new Set<ReturnType<typeof Bun.spawn>>();
  function kill(child: ReturnType<typeof Bun.spawn>) {
    try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
  }
  const cleanup = () => { for (const child of children) kill(child); };
  const interrupted = () => process.exit(130);
  process.on("exit", cleanup);
  process.on("SIGINT", interrupted);
  process.on("SIGTERM", interrupted);
  async function run(command: string[], env: Record<string, string | undefined> = {}) {
    const start = performance.now();
    const child = Bun.spawn(command, { cwd: root, detached: true, stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env } });
    children.add(child);
    let timedOut = false;
    const watchdog = setTimeout(() => { timedOut = true; kill(child); }, timeout);
    try {
      const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      if (timedOut || status !== 0) throw new Error(`${command.join(" ")} failed (${timedOut ? "timeout" : status}):\n${stderr || stdout}`);
      return { milliseconds: performance.now() - start, stdout, stderr };
    } finally { clearTimeout(watchdog); children.delete(child); }
  }
  const hash = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
  type Variant = { id: string; source: string; defines: string[]; executable: string; compileMilliseconds: number; binaryBytes: number; samples: number[]; checksum: string; sourceSha256: string; removed: string[]; sanitizerValidated: boolean };
  const results: { kernel: string; profile: string; emitMilliseconds: Record<string, number>; variants: Variant[] }[] = [];
  try {
    const revision = (await run(["git", "rev-parse", "HEAD"])).stdout.trim();
    const compilerDiff = (await run(["git", "diff", "HEAD", "--", "compiler"])).stdout;
    if (compilerDiff) throw new Error("Benchmark a committed compiler: compiler/ has uncommitted changes");
    const dirty = (await run(["git", "status", "--porcelain"])).stdout.trim().length > 0;
    const toolchain = (await run(["clang", "--version"])).stdout.trim();
    const seed = await run([process.execPath, resolve(root, "compiler/src/cli.ts"), "self-host-emit", resolve(root, "compiler/driver/main.zs")]);
    const nativeSourceSha256 = hash(readFileSync(`${native}.c`));
    if (hash(seed.stdout) !== nativeSourceSha256) throw new Error("Native bootstrap source is stale; run bun run bootstrap first.");
    const nativeSha256 = hash(readFileSync(native));
    const sourceFiles = ["input.h", "input.c", "kernels.zs", "reference.c", ...cases.map(c => `${c}.zs`)];
    const sourceHashes = Object.fromEntries(sourceFiles.map(file => [file, hash(readFileSync(resolve(inputs, file)))]));
    const harnessSha256 = hash(readFileSync(import.meta.path));
    const supportHashes = Object.fromEntries(["bench.c", "bench.h"].map(file => [file, hash(readFileSync(resolve(root, "benchmarks/support", file)))]));
    const support = resolve(work, "support.o");
    const input = resolve(work, "input.o");
    await run(["clang", "-std=c11", "-O2", "-c", resolve(root, "benchmarks/support/bench.c"), "-o", support]);
    await run(["clang", "-std=c11", "-O2", "-c", resolve(inputs, "input.c"), "-o", input]);
    for (const [caseIndex, kernel] of cases.entries()) {
      const emitted: Record<string, string> = {};
      const emitMilliseconds: Record<string, number> = {};
      for (const emitter of ["stage0", "native"] as const) {
        const driver = emitter === "stage0" ? [process.execPath, resolve(root, "compiler/src/cli.ts")] : [native];
        const result = await run([...driver, "emit", resolve(inputs, `${kernel}.zs`)]);
        emitted[emitter] = result.stdout;
        emitMilliseconds[emitter] = result.milliseconds;
      }
      for (const profile of profiles) {
        console.log(`building ${kernel}/${profile}`);
        const directory = resolve(work, `${kernel}-${profile}`);
        mkdirSync(directory);
        const variants: Variant[] = [];
        for (const emitter of ["c", "stage0", "native"] as const) for (const bounds of ["checked", "bounds-removed"] as const) {
          const id = `${emitter}-${bounds}`;
          let generated = emitter === "c" ? readFileSync(resolve(inputs, "reference.c"), "utf8") : emitted[emitter]!;
          if (isolated && emitter !== "c") generated = isolateBenchmarkKernel(generated, kernel);
          const altered = bounds === "bounds-removed" && emitter !== "c" ? removeBenchmarkBounds(generated, emitter) : { source: generated, removed: [] };
          const source = resolve(directory, `${id}.c`);
          writeFileSync(source, altered.source);
          const defines = emitter === "c" ? [`-DBENCH_CASE=${caseIndex}`, `-DBENCH_NAME="${kernel}"`, ...(bounds === "bounds-removed" ? ["-DBENCH_REMOVE_BOUNDS"] : []), ...(isolated ? ["-DBENCH_ISOLATE"] : [])] : [];
          const executable = resolve(directory, id);
          const flags = ["-std=c11", `-${profile}`, "-DNDEBUG", "-Wall", "-Wextra", "-Werror", "-I", inputs, ...defines];
          const built = await run(["clang", ...flags, source, support, input, "-o", executable]);
          await run(["clang", ...flags, "-S", source, "-o", `${executable}.s`]);
          await run(["clang", ...flags, "-S", "-emit-llvm", source, "-o", `${executable}.ll`]);
          const sanitized = `${executable}-ubsan`;
          await run(["clang", ...flags, "-fsanitize=undefined", "-fno-sanitize-recover=all", source, support, input, "-o", sanitized]);
          async function invoke(binary: string, size: number, repetitions: number) {
            const result = await run([binary], { Z_INDEX_WIDTH: String(size), Z_BENCH_ITERATIONS: String(repetitions), Z_BENCH_TRACK_ALLOCATIONS: "0", UBSAN_OPTIONS: "halt_on_error=1" });
            const match = /^RESULT (\S+) (\d+) (\d+)$/m.exec(result.stdout);
            if (!match || match[1] !== kernel) throw new Error(`invalid result: ${result.stdout}`);
            return { nanoseconds: Number(match[2]), checksum: match[3]! };
          }
          for (const size of [1, 17, 257]) {
            const oracle = expectedChecksum(kernel, size, 3);
            for (const binary of [executable, sanitized]) {
              if ((await invoke(binary, size, 3)).checksum !== oracle) throw new Error(`${kernel}/${id}: checksum mismatch at width ${size}`);
            }
          }
          variants.push({ id, source: relative(root, source), defines, executable, compileMilliseconds: built.milliseconds, binaryBytes: statSync(executable).size, samples: [], checksum: "", sourceSha256: hash(altered.source), removed: altered.removed, sanitizerValidated: true });
        }
        // Rotate and alternate order to distribute warm-host and temporal bias.
        // All compilation and sanitizer work finishes before measurement begins.
        for (let trial = 0; trial < warmups + samples; ++trial) {
          const rotated = [...variants.slice(trial % variants.length), ...variants.slice(0, trial % variants.length)];
          const order = trial % 2 ? rotated.reverse() : rotated;
          for (const variant of order) {
            const runResult = await run([variant.executable], { Z_INDEX_WIDTH: String(width), Z_BENCH_ITERATIONS: String(rounds), Z_BENCH_TRACK_ALLOCATIONS: "0" });
            const match = /^RESULT (\S+) (\d+) (\d+)$/m.exec(runResult.stdout);
            if (!match || match[1] !== kernel) throw new Error(`invalid result: ${runResult.stdout}`);
            if (variant.checksum && variant.checksum !== match[3]) throw new Error(`unstable checksum: ${variant.id}`);
            variant.checksum = match[3]!;
            if (trial >= warmups) variant.samples.push(Number(match[2]));
          }
        }
        if (new Set(variants.map(v => v.checksum)).size !== 1) throw new Error(`${kernel}/${profile}: checked reference and generated checksums differ`);
        results.push({ kernel, profile, emitMilliseconds, variants });
        console.log(variants.map(v => `${v.id}: ${(median(v.samples) / 1e6).toFixed(2)} ms`).join("; "));
      }
    }
    if ((await run(["git", "rev-parse", "HEAD"])).stdout.trim() !== revision || (await run(["git", "diff", "HEAD", "--", "compiler"])).stdout) throw new Error("compiler changed during measurement; discard this run");
    for (const file of sourceFiles) if (hash(readFileSync(resolve(inputs, file))) !== sourceHashes[file]) throw new Error(`benchmark input changed: ${file}`);
    if (hash(readFileSync(import.meta.path)) !== harnessSha256) throw new Error("benchmark harness changed during measurement");
    if (hash(readFileSync(native)) !== nativeSha256) throw new Error("native compiler changed during measurement");
    for (const file of ["bench.c", "bench.h"]) if (hash(readFileSync(resolve(root, "benchmarks/support", file))) !== supportHashes[file]) throw new Error(`benchmark support changed: ${file}`);
    const report = {
      generatedAt: new Date().toISOString(), revision, dirty,
      system: { platform: platform(), release: release(), arch: arch(), cpu: cpus()[0]?.model },
      toolchain, bun: Bun.version, width, rounds, operations: width * rounds, samples, warmups, isolated,
      emitterCommands: { stage0: "bun compiler/src/cli.ts emit", native: `${native} emit` },
      nativeSha256, nativeSourceSha256,
      sourceHashes, harnessSha256, supportHashes, artifacts: relative(root, work),
      boundary: "Kernel clock time only. Setup, allocation, cleanup, compilation and process startup excluded. Data-dependent wrapping checksum prevents loop folding. Identical Clang profiles; bounds-removed variants change only array indexing guards and are valid-input experiments, not safe programs on arbitrary inputs. UBSan and independent BigInt oracle validate small inputs; checked C validates measured checksums. No allocation counts or engine-speed claims. " + (isolated ? "Opaque-function control: selected kernel declaration/definition made externally visible and noinline in generated C and the C reference, preventing caller-specific inlining/specialization. This is not default Z codegen or a proposed public attribute." : "Normal optimizer inlining; caller buffer construction is visible to Clang."),
      results,
    };
    const output = resolve(process.env.Z_INDEX_REPORT ?? resolve(root, `benchmarks/results/checked-indexing${isolated ? "-isolated" : ""}-${new Date().toISOString().slice(0, 10)}-${process.platform}-${process.arch}.json`));
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
    const rows = results.flatMap(row => ["c", "stage0", "native"].map(emitter => {
      const checked = row.variants.find(v => v.id === `${emitter}-checked`)!;
      const control = row.variants.find(v => v.id === `${emitter}-bounds-removed`)!;
      const describe = (v: Variant) => `${(median(v.samples) / 1e6).toFixed(3)} (${(Math.min(...v.samples) / 1e6).toFixed(3)}–${(Math.max(...v.samples) / 1e6).toFixed(3)})`;
      return `| ${row.kernel} | ${row.profile} | ${emitter} | ${describe(checked)} | ${describe(control)} | ${(100 * (1 - median(control.samples) / median(checked.samples))).toFixed(1)}% |`;
    }));
    writeFileSync(output.replace(/\.json$/, "") + ".md", `# Checked-indexing checkpoint\n\n${report.generatedAt}\n\nCompiler ${revision}; worktree dirty: ${dirty}. ${report.system.cpu}; ${report.system.platform} ${report.system.release} ${report.system.arch}.\n\n${width} elements × ${rounds} rounds (${report.operations} operations), ${warmups} warmups, ${samples} samples per variant.\n\n${report.boundary}\n\nMedians (min–max) in milliseconds. Negative reduction means the experimental variant was slower; small differences need repeated runs.\n\n| Kernel | Profile | Emitter | Checked | Bounds removed | Median reduction |\n| --- | --- | --- | ---: | ---: | ---: |\n${rows.join("\n")}\n\nRaw samples, toolchain, checksums, exact source hashes, changed helper names and compilation observations are in the adjacent JSON. Generated C, optimized LLVM IR and assembly remain under \`${relative(root, work)}\`. Native rows use the bootstrapped driver, including imported-header metadata. The adjacent bootstrap C is verified against current self-emission; binary and source hashes are recorded. Single emission/build timings are observations, not a comparative compiler-speed result.\n`);
    console.log(`wrote ${output}`);
  } finally {
    cleanup();
    process.off("exit", cleanup);
    process.off("SIGINT", interrupted);
    process.off("SIGTERM", interrupted);
  }
}

if (import.meta.main) await main();
