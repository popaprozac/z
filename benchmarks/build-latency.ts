// Whole-project compilation latency, not a runtime or clean-machine benchmark.
// Fresh project caches still share the host's filesystem and compiler/SDK caches.
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { cpus, platform, release, arch } from "node:os";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const native = resolve(process.env.Z_BENCH_NATIVE ?? resolve(root, ".z-cache/bootstrap/z"));
if (!existsSync(native)) throw new Error("Run bun run bootstrap before this benchmark.");
function positive(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}
const trials = positive("Z_BUILD_BENCH_TRIALS", 3);
const modules = positive("Z_BUILD_BENCH_MODULES", 24);
const functionsPerModule = positive("Z_BUILD_BENCH_FUNCTIONS", 16);
const timeout = positive("Z_BENCH_TIMEOUT_MS", 180_000);
const output = resolve(process.env.Z_BUILD_BENCH_REPORT ?? resolve(root, "benchmarks/results/build-latency.json"));
const temporaryRoot = resolve(root, ".z-cache/benchmarks");
mkdirSync(temporaryRoot, { recursive: true });
const work = mkdtempSync(resolve(temporaryRoot, "build-latency-"));
const children = new Set<ReturnType<typeof Bun.spawn>>();
function kill(child: ReturnType<typeof Bun.spawn>) {
  try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
}
process.on("exit", () => { for (const child of children) kill(child); });
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => process.exit(130));
async function run(command: string[], cwd = root) {
  const start = performance.now();
  const child = Bun.spawn(command, { cwd, detached: true, stdout: "pipe", stderr: "pipe" });
  children.add(child);
  let timedOut = false;
  const watchdog = setTimeout(() => { timedOut = true; kill(child); }, timeout);
  try {
    const [status, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    if (timedOut || status !== 0) throw new Error(`${command.join(" ")} failed (${timedOut ? "timeout" : status}):\n${stderr || stdout}`);
    return { seconds: (performance.now() - start) / 1000, stdout, stderr };
  } finally { clearTimeout(watchdog); children.delete(child); }
}
function source(module: number, changed = false): string {
  const functions = Array.from({ length: functionsPerModule }, (_, index) =>
    `function part${index}(value: i32): i32 { return value + ${module + 1 + index + (changed && index === 0 ? 1000 : 0)}; }`);
  return functions.join("\n") + `\nexport function sum${module}(value: i32): i32 { return `
    + functions.map((_, index) => `part${index}(value)`).join(" + ") + "; }\n";
}
function fixture(directory: string): void {
  mkdirSync(directory);
  writeFileSync(resolve(directory, "z.json"), JSON.stringify({ target: { name: "latency", entry: "main.zs" } }, null, 2));
  writeFileSync(resolve(directory, "detail.h"), "#define BUILD_BIAS 3\n");
  writeFileSync(resolve(directory, "bias.h"), '#include "detail.h"\nstatic inline int bench_bias(void) { return BUILD_BIAS; }\n');
  const imports = [];
  for (let module = 0; module < modules; ++module) {
    writeFileSync(resolve(directory, `module${module}.zs`), source(module));
    imports.push(`import { sum${module} } from "./module${module}.zs";`);
  }
  writeFileSync(resolve(directory, "main.zs"), imports.join("\n")
    + '\nimport native from "./bias.h";\nimport console from "std/console";\n'
    + "function main(): i32 {\n  const checksum = "
    + Array.from({ length: modules }, (_, module) => `sum${module}(1)`).join(" + ")
    + " + native.bench_bias();\n  console.log(`${checksum}`);\n  return 0;\n}\n");
}
type Measurement = { trial: number; driver: string; scenario: string; seconds: number; cacheHit: boolean; binaryBytes: number; checksum: number };
const measurements: Measurement[] = [];
try {
  const drivers = [
    { name: "stage0", command: [process.execPath, resolve(root, "compiler/src/cli.ts")] },
    { name: "native", command: [native] },
  ];
  for (let trial = 0; trial < trials; ++trial) {
    // Alternate order so one driver does not always receive the warmer host.
    for (const driver of trial % 2 === 0 ? drivers : [...drivers].reverse()) {
      const directory = resolve(work, `${driver.name}-${trial}`);
      fixture(directory);
      const base = modules * functionsPerModule
        + functionsPerModule * modules * (modules + 1) / 2
        + modules * functionsPerModule * (functionsPerModule - 1) / 2;
      async function measure(scenario: string, checksum: number, release = false, expectedHit = false) {
        const built = await run([...driver.command, "build", directory, ...(release ? ["--release"] : [])]);
        const binary = resolve(directory, "build/latency");
        const executed = await run([binary]);
        if (executed.stdout.trim() !== String(checksum)) throw new Error(`${driver.name} ${scenario}: stale or incorrect executable: ${executed.stdout}`);
        const cacheHit = built.stdout.includes("cache hit:");
        if (driver.name === "native" && cacheHit !== expectedHit) throw new Error(`${scenario}: expected native cacheHit=${expectedHit}, got ${cacheHit}`);
        const row = { trial: trial + 1, driver: driver.name, scenario, seconds: built.seconds, cacheHit, binaryBytes: statSync(binary).size, checksum };
        measurements.push(row);
        console.log(`${driver.name} #${trial + 1} ${scenario}: ${built.seconds.toFixed(3)} s${cacheHit ? " (cache hit)" : ""}`);
      }
      await measure("fresh-project-cache", base + 3);
      await measure("unchanged", base + 3, false, true);
      writeFileSync(resolve(directory, "module0.zs"), source(0, true));
      await measure("one-module-change", base + 1003);
      await measure("source-unchanged", base + 1003, false, true);
      writeFileSync(resolve(directory, "detail.h"), "#define BUILD_BIAS 7\n");
      await measure("transitive-header-change", base + 1007);
      await measure("header-unchanged", base + 1007, false, true);
      await measure("switch-to-release", base + 1007, true);
      await measure("release-unchanged", base + 1007, true, true);
      await measure("return-to-debug", base + 1007);
      await measure("debug-unchanged", base + 1007, false, true);
    }
  }
  const report = {
    generatedAt: new Date().toISOString(),
    revision: (await run(["git", "rev-parse", "HEAD"])).stdout.trim(),
    dirty: (await run(["git", "status", "--porcelain"])).stdout.trim().length > 0,
    system: { platform: platform(), release: release(), arch: arch(), cpu: cpus()[0]?.model },
    toolchains: { bun: Bun.version, native: (await run([native, "version"])).stdout.trim(), clang: (await run(["clang", "--version"])).stdout.trim() },
    workload: { modules, functionsPerModule, trials },
    boundary: "Wall time of z build only. Executable/checksum validation excluded. Fresh project caches; warm host filesystem/toolchain. Debug O0; release O2. No GUI or Zapp prerequisites.",
    measurements,
  };
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
  function median(values: number[]) { const sorted = values.toSorted((a, b) => a - b); return sorted.length % 2 ? sorted[sorted.length >> 1]! : (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2; }
  const scenarios = [...new Set(measurements.map(row => row.scenario))];
  const table = scenarios.map(scenario => `| ${scenario} | ` + drivers.map(driver => {
    const values = measurements.filter(row => row.driver === driver.name && row.scenario === scenario).map(row => row.seconds);
    return `${median(values).toFixed(3)} s (${Math.min(...values).toFixed(3)}–${Math.max(...values).toFixed(3)})`;
  }).join(" | ") + " |").join("\n");
  writeFileSync(output.replace(/\.json$/, "") + ".md", `# Z build-latency checkpoint

${report.generatedAt}

${modules} modules × ${functionsPerModule} helpers, ${trials} trials per driver.
${report.system.cpu}; ${report.system.platform} ${report.system.release} ${report.system.arch}.

${report.boundary}

Medians (min–max); complete raw samples and toolchain identities in the adjacent JSON.

| Scenario | Stage 0 | Native |
| --- | ---: | ---: |
${table}

Source and transitive-header changes alter the verified executable checksum.
Every native unchanged row must report a cache hit; every changed/profile-switch
row must miss. This measures whole-project caching, not module-level incremental
compilation. Compiler replacement, generated overlays, .zd changes, peak memory,
and cold-machine SDK setup require separate probes.
`);
  console.log(`wrote ${output}`);
} finally { rmSync(work, { recursive: true, force: true }); }
