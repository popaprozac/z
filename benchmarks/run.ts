import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Case = {
  readonly id: string;
  readonly iterations: number;
  readonly reference: string;
  readonly referenceLanguage: "c" | "c++" | "z";
  readonly additionalVariants?: readonly AdditionalVariant[];
  readonly semantics: string;
  readonly linkArguments?: readonly string[];
};

type AdditionalVariant = {
  readonly id: "rust" | "zig" | "nim" | "go";
  readonly source: string;
};

type Invocation = {
  readonly nanoseconds: number;
  readonly checksum: string;
  readonly allocations: number;
  readonly frees: number;
  readonly requestedBytes: number;
};

type VariantResult = {
  readonly id: string;
  readonly compileMilliseconds: number;
  readonly binaryBytes: number;
  readonly strippedBinaryBytes: number;
  readonly samples: readonly number[];
  readonly medianNanoseconds: number;
  readonly minimumNanoseconds: number;
  readonly checksum: string;
  readonly allocations: number;
  readonly frees: number;
  readonly requestedBytes: number;
  readonly allocationsMeasured: boolean;
};

type CaseResult = {
  readonly definition: Case;
  readonly zEmitMilliseconds: number;
  readonly z: VariantResult;
  readonly reference: VariantResult;
  readonly additional: readonly VariantResult[];
};

type HyperfineResult = {
  readonly command: string;
  readonly meanSeconds: number;
  readonly standardDeviationSeconds: number;
};

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const benchmarkRoot = join(root, "benchmarks");
const buildRoot = join(benchmarkRoot, ".build");
const supportSource = join(benchmarkRoot, "support", "bench.c");
const compiler = join(root, "compiler", "src", "cli.ts");
const nimOnPath = spawnSync("which", ["nim"], { encoding: "utf8" });
const nimCompiler = process.env.Z_NIM
  ?? (nimOnPath.stdout.trim() || join(process.env.HOME ?? "", ".nimble", "bin", "nim"));
const samples = positiveInteger(process.env.Z_BENCH_SAMPLES, 9);
const warmups = positiveInteger(process.env.Z_BENCH_WARMUPS, 2);
const scale = positiveNumber(process.env.Z_BENCH_SCALE, 1);

const caseDefinitions: readonly Case[] = [
  {
    id: "arithmetic",
    iterations: 50_000_000,
    reference: "reference.c",
    referenceLanguage: "c",
    additionalVariants: [
      { id: "rust", source: "reference.rs" },
      { id: "zig", source: "reference.zig" },
      { id: "nim", source: "reference.nim" },
    ],
    semantics: "u64 wrapping arithmetic in a runtime-sized loop",
  },
  {
    id: "direct-c-call",
    iterations: 30_000_000,
    reference: "reference.c",
    referenceLanguage: "c",
    additionalVariants: [
      { id: "rust", source: "reference.rs" },
      { id: "zig", source: "reference.zig" },
      { id: "nim", source: "reference.nim" },
    ],
    semantics: "one non-inlined imported C call per iteration",
  },
  {
    id: "dynamic-array",
    iterations: 5_000_000,
    reference: "reference.c",
    referenceLanguage: "c",
    additionalVariants: [
      { id: "rust", source: "reference.rs" },
      { id: "zig", source: "reference.zig" },
      { id: "nim", source: "reference.nim" },
    ],
    semantics: "native dynamic sequence growth, checked indexing, scan, and cleanup",
  },
  {
    id: "struct-ownership",
    iterations: 20_000_000,
    reference: "reference.cpp",
    referenceLanguage: "c++",
    additionalVariants: [
      { id: "rust", source: "reference.rs" },
      { id: "zig", source: "reference.zig" },
      { id: "nim", source: "reference.nim" },
    ],
    semantics: "unique value transfer and exactly-once deterministic destruction",
  },
  {
    id: "async-task-pair",
    iterations: 100_000,
    reference: "reference.zs",
    referenceLanguage: "z",
    semantics: "two hot structured child tasks versus two direct awaits in the same Z async runtime",
  },
  {
    id: "native-thread",
    iterations: 1_000,
    reference: "reference.c",
    referenceLanguage: "c",
    additionalVariants: [
      { id: "rust", source: "reference.rs" },
      { id: "zig", source: "reference.zig" },
    ],
    semantics: "one OS thread creation, one owned result transfer, and one join per iteration",
    linkArguments: ["-pthread"],
  },
  {
    id: "channel-local",
    iterations: 2_000_000,
    reference: "reference.c",
    referenceLanguage: "c",
    additionalVariants: [
      { id: "rust", source: "reference.rs" },
      { id: "go", source: "reference.go" },
    ],
    semantics: "one capacity-1 channel send followed by one receive on the same thread",
    linkArguments: ["-pthread"],
  },
  {
    id: "channel-thread",
    iterations: 250_000,
    reference: "reference.c",
    referenceLanguage: "c",
    additionalVariants: [
      { id: "rust", source: "reference.rs" },
      { id: "go", source: "reference.go" },
    ],
    semantics: "one async producer and one dedicated synchronous consumer; the blocking native references isolate Z's additional task-frame cost rather than matching scheduling semantics",
    linkArguments: ["-pthread"],
  },
  {
    id: "channel-thread-sync",
    iterations: 250_000,
    reference: "../channel-thread/reference.c",
    referenceLanguage: "c",
    additionalVariants: [
      { id: "rust", source: "../channel-thread/reference.rs" },
      { id: "go", source: "../channel-thread/reference.go" },
    ],
    semantics: "one synchronous producer and one dedicated synchronous consumer thread transferring u64 values through a capacity-1 channel",
    linkArguments: ["-pthread"],
  },
];
const requestedCaseIds = new Set(
  (process.env.Z_BENCH_CASES ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);
const cases = requestedCaseIds.size === 0
  ? caseDefinitions
  : caseDefinitions.filter((definition) => requestedCaseIds.has(definition.id));
if (cases.length === 0 || cases.length !== (requestedCaseIds.size || cases.length)) {
  const known = caseDefinitions.map((definition) => definition.id).join(", ");
  throw new Error(`Z_BENCH_CASES must name known cases: ${known}`);
}

rmSync(buildRoot, { recursive: true, force: true });
mkdirSync(buildRoot, { recursive: true });

const supportObject = join(buildRoot, "bench-support.o");
run("clang", ["-std=c17", "-O3", "-DNDEBUG", "-c", supportSource, "-o", supportObject]);

const results: CaseResult[] = [];
for (const definition of cases) {
  process.stdout.write(`benchmarking ${definition.id}... `);
  const caseDirectory = join(benchmarkRoot, "cases", definition.id);
  const outputDirectory = join(buildRoot, definition.id);
  mkdirSync(outputDirectory, { recursive: true });

  const zSource = join(caseDirectory, "main.zs");
  const generatedSource = join(outputDirectory, "z-generated.c");
  const emitTimes: number[] = [];
  let generated = "";
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const started = performance.now();
    generated = run(process.execPath, [compiler, "emit", zSource]).stdout;
    emitTimes.push(performance.now() - started);
  }
  writeFileSync(generatedSource, generated);

  const z = buildVariant({
    id: definition.id,
    variant: "z",
    source: generatedSource,
    language: "c",
    includeDirectory: caseDirectory,
    outputDirectory,
    supportObject,
    iterations: Math.max(1, Math.floor(definition.iterations * scale)),
    linkArguments: definition.linkArguments ?? [],
  });
  let referenceSource = join(caseDirectory, definition.reference);
  let referenceLanguage: "c" | "c++" = definition.referenceLanguage === "z"
    ? "c"
    : definition.referenceLanguage;
  if (definition.referenceLanguage === "z") {
    const referenceGenerated = run(process.execPath, [compiler, "emit", referenceSource]).stdout;
    referenceSource = join(outputDirectory, "reference-generated.c");
    writeFileSync(referenceSource, referenceGenerated);
  }
  const reference = buildVariant({
    id: definition.id,
    variant: definition.referenceLanguage === "z"
      ? "z-direct-await"
      : definition.referenceLanguage,
    source: referenceSource,
    language: referenceLanguage,
    includeDirectory: caseDirectory,
    outputDirectory,
    supportObject,
    iterations: Math.max(1, Math.floor(definition.iterations * scale)),
    linkArguments: definition.linkArguments ?? [],
  });
  const additional = (definition.additionalVariants ?? []).map((variant) => buildExternalVariant({
    id: definition.id,
    variant,
    source: join(caseDirectory, variant.source),
    outputDirectory,
    supportObject,
    iterations: Math.max(1, Math.floor(definition.iterations * scale)),
  }));
  for (const result of [reference, ...additional]) {
    if (z.checksum !== result.checksum) {
      throw new Error(`${definition.id}: checksum mismatch: Z=${z.checksum}, ${result.id}=${result.checksum}`);
    }
  }
  results.push({
    definition,
    zEmitMilliseconds: median(emitTimes),
    z,
    reference,
    additional,
  });
  const comparisons = [
    `${formatRatio(z.medianNanoseconds / reference.medianNanoseconds)} Z/${reference.id}`,
    ...additional.map((variant) => `${formatRatio(z.medianNanoseconds / variant.medianNanoseconds)} Z/${variant.id}`),
  ];
  console.log(comparisons.join(", "));
}

const hyperfine = cases.some((definition) => definition.id === "arithmetic")
  ? runHyperfineArithmetic()
  : [];
const report = renderReport(results, hyperfine);
const reportPath = join(
  benchmarkRoot,
  "results",
  process.env.Z_BENCH_REPORT ?? "checkpoint-1-macos-arm64.md",
);
mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, report);
console.log(`\nwrote ${reportPath}`);
console.log(report);

function buildVariant(options: {
  readonly id: string;
  readonly variant: string;
  readonly source: string;
  readonly language: "c" | "c++";
  readonly includeDirectory: string;
  readonly outputDirectory: string;
  readonly supportObject: string;
  readonly iterations: number;
  readonly linkArguments: readonly string[];
}): VariantResult {
  const driver = options.language === "c++" ? "clang++" : "clang";
  const standard = options.language === "c++" ? "-std=c++20" : "-std=c17";
  const object = join(options.outputDirectory, `${options.variant}.o`);
  const executable = join(options.outputDirectory, options.variant);
  const assembly = join(options.outputDirectory, `${options.variant}.s`);
  const languageArguments = options.language === "c++"
    ? ["-fno-exceptions", "-fno-rtti"]
    : [];
  const allocationMacros = [
    "-Dmalloc=z_bench_malloc",
    "-Dcalloc=z_bench_calloc",
    "-Drealloc=z_bench_realloc",
    "-Dfree=z_bench_free",
  ];
  const compileArguments = [
    standard,
    "-O3",
    "-DNDEBUG",
    "-Wall",
    "-Wextra",
    "-Werror",
    ...languageArguments,
    ...allocationMacros,
    "-I",
    options.includeDirectory,
    "-c",
    options.source,
    "-o",
    object,
  ];
  const compileStarted = performance.now();
  run(driver, compileArguments);
  run(driver, [object, options.supportObject, ...options.linkArguments, "-o", executable]);
  const compileMilliseconds = performance.now() - compileStarted;
  run(driver, [
    standard,
    "-O3",
    "-DNDEBUG",
    ...languageArguments,
    ...allocationMacros,
    "-I",
    options.includeDirectory,
    "-S",
    options.source,
    "-o",
    assembly,
  ]);

  for (let iteration = 0; iteration < warmups; iteration += 1) {
    invoke(executable, options.iterations, false);
  }
  const invocations: Invocation[] = [];
  for (let iteration = 0; iteration < samples; iteration += 1) {
    invocations.push(invoke(executable, options.iterations, false));
  }
  const tracked = invoke(executable, options.iterations, true);
  const checksum = invocations[0]?.checksum ?? tracked.checksum;
  if (!invocations.every((result) => result.checksum === checksum)) {
    throw new Error(`${options.id}/${options.variant}: unstable checksum`);
  }

  const stripped = `${executable}-stripped`;
  copyFileSync(executable, stripped);
  const strip = spawnSync("strip", ["-x", stripped], { encoding: "utf8" });
  const strippedBinaryBytes = strip.status === 0 ? statSync(stripped).size : statSync(executable).size;
  return {
    id: options.variant,
    compileMilliseconds,
    binaryBytes: statSync(executable).size,
    strippedBinaryBytes,
    samples: invocations.map((result) => result.nanoseconds),
    medianNanoseconds: median(invocations.map((result) => result.nanoseconds)),
    minimumNanoseconds: Math.min(...invocations.map((result) => result.nanoseconds)),
    checksum,
    allocations: tracked.allocations,
    frees: tracked.frees,
    requestedBytes: tracked.requestedBytes,
    allocationsMeasured: true,
  };
}

function buildExternalVariant(options: {
  readonly id: string;
  readonly variant: AdditionalVariant;
  readonly source: string;
  readonly outputDirectory: string;
  readonly supportObject: string;
  readonly iterations: number;
}): VariantResult {
  const executable = join(options.outputDirectory, options.variant.id);
  const assembly = join(options.outputDirectory, `${options.variant.id}.s`);
  const compileStarted = performance.now();

  if (options.variant.id === "rust") {
    run("rustc", [
      "--edition=2024",
      "-C", "opt-level=3",
      "-C", "debuginfo=0",
      "-C", "panic=abort",
      "-C", `link-arg=${options.supportObject}`,
      options.source,
      "-o", executable,
    ]);
  } else if (options.variant.id === "zig") {
    run("zig", [
      "build-exe",
      options.source,
      options.supportObject,
      "-O", "ReleaseSafe",
      "-lc",
      `-femit-bin=${executable}`,
    ], {
      ...process.env,
      ZIG_GLOBAL_CACHE_DIR: join(buildRoot, "zig-global-cache"),
      ZIG_LOCAL_CACHE_DIR: join(buildRoot, "zig-local-cache"),
    });
  } else if (options.variant.id === "nim") {
    run(nimCompiler, [
      "c",
      "--hints:off",
      "--warnings:off",
      "-d:release",
      "--mm:arc",
      "--opt:speed",
      `--passL:${options.supportObject}`,
      `--nimcache:${join(options.outputDirectory, "nimcache")}`,
      `--out:${executable}`,
      options.source,
    ]);
  } else {
    run("go", [
      "build",
      "-trimpath",
      "-ldflags=-s -w",
      "-o", executable,
      options.source,
    ], {
      ...process.env,
      GOCACHE: join(buildRoot, "go-cache"),
    });
  }
  const compileMilliseconds = performance.now() - compileStarted;

  if (options.variant.id === "rust") {
    run("rustc", [
      "--edition=2024",
      "-C", "opt-level=3",
      "--emit", `asm=${assembly}`,
      options.source,
    ]);
  } else if (options.variant.id === "zig") {
    run("zig", [
      "build-obj",
      options.source,
      "-O", "ReleaseSafe",
      "-lc",
      `-femit-asm=${assembly}`,
      `-femit-bin=${join(options.outputDirectory, `${options.variant.id}.o`)}`,
    ], {
      ...process.env,
      ZIG_GLOBAL_CACHE_DIR: join(buildRoot, "zig-global-cache"),
      ZIG_LOCAL_CACHE_DIR: join(buildRoot, "zig-local-cache"),
    });
  }

  for (let iteration = 0; iteration < warmups; iteration += 1) {
    invoke(executable, options.iterations, false);
  }
  const invocations: Invocation[] = [];
  for (let iteration = 0; iteration < samples; iteration += 1) {
    invocations.push(invoke(executable, options.iterations, false));
  }
  const checksum = invocations[0]?.checksum ?? "";
  if (!invocations.every((result) => result.checksum === checksum)) {
    throw new Error(`${options.id}/${options.variant.id}: unstable checksum`);
  }

  const stripped = `${executable}-stripped`;
  copyFileSync(executable, stripped);
  const strip = spawnSync("strip", ["-x", stripped], { encoding: "utf8" });
  return {
    id: options.variant.id,
    compileMilliseconds,
    binaryBytes: statSync(executable).size,
    strippedBinaryBytes: strip.status === 0 ? statSync(stripped).size : statSync(executable).size,
    samples: invocations.map((result) => result.nanoseconds),
    medianNanoseconds: median(invocations.map((result) => result.nanoseconds)),
    minimumNanoseconds: Math.min(...invocations.map((result) => result.nanoseconds)),
    checksum,
    allocations: 0,
    frees: 0,
    requestedBytes: 0,
    allocationsMeasured: false,
  };
}

function invoke(executable: string, iterations: number, trackAllocations: boolean): Invocation {
  const execution = run(executable, [], {
    ...process.env,
    Z_BENCH_ITERATIONS: String(iterations),
    Z_BENCH_TRACK_ALLOCATIONS: trackAllocations ? "1" : "0",
  });
  const result = execution.stdout.match(/^RESULT ([^ ]+) ([0-9]+) ([0-9]+)$/m);
  if (!result) throw new Error(`${executable}: malformed benchmark output:\n${execution.stdout}`);
  const allocation = execution.stdout.match(/^ALLOC ([0-9]+) ([0-9]+) ([0-9]+)$/m);
  return {
    nanoseconds: Number(result[2]),
    checksum: result[3],
    allocations: allocation ? Number(allocation[1]) : 0,
    frees: allocation ? Number(allocation[2]) : 0,
    requestedBytes: allocation ? Number(allocation[3]) : 0,
  };
}

function run(
  command: string,
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): { readonly stdout: string; readonly stderr: string } {
  const result = spawnSync(command, arguments_, {
    cwd: root,
    env: environment,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${basename(command)} ${arguments_.join(" ")} failed (${result.status}):\n${result.stderr || result.stdout}`,
    );
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

function runHyperfineArithmetic(): readonly HyperfineResult[] {
  const directory = join(buildRoot, "arithmetic");
  const output = join(buildRoot, "hyperfine-arithmetic.json");
  const commands = ["z", "c", "rust", "zig", "nim"].map((variant) => join(directory, variant));
  run("hyperfine", [
    "--warmup", "2",
    "--runs", "10",
    "--export-json", output,
    ...commands,
  ], {
    ...process.env,
    Z_BENCH_ITERATIONS: String(cases.find((definition) => definition.id === "arithmetic")!.iterations),
  });
  const parsed = JSON.parse(readFileSync(output, "utf8")) as {
    readonly results: readonly {
      readonly command: string;
      readonly mean: number;
      readonly stddev: number;
    }[];
  };
  return parsed.results.map((result) => ({
    command: basename(result.command),
    meanSeconds: result.mean,
    standardDeviationSeconds: result.stddev,
  }));
}

function renderReport(
  results_: readonly CaseResult[],
  hyperfine_: readonly HyperfineResult[],
): string {
  const activeCases = new Set(results_.map((result) => result.definition.id));
  const channelOnly = [...activeCases].every((id) => id.startsWith("channel-"));
  const title = channelOnly ? "Z channel performance checkpoint" : "Z performance checkpoint 1";
  const generatedAt = new Date().toISOString();
  const clangVersion = firstLine(run("clang", ["--version"]).stdout);
  const rustVersion = firstLine(run("rustc", ["--version"]).stdout);
  const zigVersion = firstLine(run("zig", ["version"]).stdout);
  const nimVersion = firstLine(run(nimCompiler, ["--version"]).stdout);
  const goVersion = firstLine(run("go", ["version"]).stdout);
  const hyperfineVersion = firstLine(run("hyperfine", ["--version"]).stdout);
  const osVersion = firstLine(run("sw_vers", ["-productVersion"]).stdout);
  const hardware = firstLine(run("uname", ["-m"]).stdout);
  const rows = results_.flatMap((result) => {
    const baseline = result.reference;
    return [result.z, baseline, ...result.additional].map((variant) => {
      const ratio = variant.medianNanoseconds / baseline.medianNanoseconds;
      return `| ${result.definition.id} | ${variant.id} | ${formatNanoseconds(variant.medianNanoseconds)} | ${formatRatio(ratio)} | ${formatAllocations(variant)} |`;
    });
  }).join("\n");
  const compilationRows = results_.flatMap((result) => (
    [result.z, result.reference, ...result.additional].map((variant) => {
      const emit = variant.id === "z" ? `${result.zEmitMilliseconds.toFixed(1)} ms` : "—";
      return `| ${result.definition.id} | ${variant.id} | ${emit} | ${variant.compileMilliseconds.toFixed(1)} ms | ${formatBytes(variant.strippedBinaryBytes)} |`;
    })
  )).join("\n");
  const semanticRows = results_.map((result) => (
    `| ${result.definition.id} | ${result.definition.semantics} |`
  )).join("\n");
  const hyperfineRows = hyperfine_.map((result) => (
    `| ${result.command} | ${(result.meanSeconds * 1000).toFixed(2)} ms | ± ${(result.standardDeviationSeconds * 1000).toFixed(2)} ms |`
  )).join("\n");
  const classificationRows = [
    { cases: ["arithmetic"], area: "Arithmetic", finding: "Z and C emit the same hot loop; Z adds a checked subtraction for elapsed-time calculation outside that loop", classification: "Zero-wrapper confirmed" },
    { cases: ["direct-c-call"], area: "Direct C call", finding: "Z emits one direct `z_bench_mix` call per iteration with no adapter", classification: "Zero-wrapper confirmed" },
    { cases: ["dynamic-array"], area: "Dynamic array", finding: "Z and C use the same 2× growth path and vectorized scan; Z retains explicit overflow guards", classification: "Optimizer removes abstraction; intentional safety checks remain" },
    { cases: ["struct-ownership"], area: "Struct ownership", finding: "Z, C++, Rust, and Zig reduce to one drop call and checksum update per iteration", classification: "Move/deinit abstraction removed" },
    { cases: ["async-task-pair"], area: "Async task pair", finding: "Child tasks and direct awaits both allocate one async frame per call; structured scheduling adds no allocation in this case", classification: "Current runtime cost, not task-syntax cost" },
    { cases: ["native-thread"], area: "Native thread", finding: "Z lowers directly to pthread create/join but carries a larger task frame and one fixed root frame", classification: "Native call confirmed; current memory overhead" },
    { cases: ["channel-local"], area: "Local channel", finding: "Z uses one preallocated bounded ring, one mutex acquisition per operation, and no per-message channel allocation", classification: "Intentional synchronization cost" },
    { cases: ["channel-thread"], area: "Async cross-thread channel", finding: "Z transfers through the bounded ring while suspending the producer through one heap-owned task frame per send", classification: "Native synchronization confirmed; async frame cost remains" },
    { cases: ["channel-thread-sync"], area: "Synchronous cross-thread channel", finding: "Z transfers through the same bounded ring and parks producer or consumer directly on native condition variables", classification: "Native synchronization confirmed" },
  ].filter((row) => row.cases.some((id) => activeCases.has(id)))
    .map((row) => `| ${row.area} | ${row.finding} | ${row.classification} |`)
    .join("\n");
  const hyperfineSection = hyperfine_.length === 0 ? "" : `
## Whole-process sanity check

Hyperfine includes process startup and reports the mean of 10 runs after 2
warmups for the 50-million-iteration arithmetic workload.

| Variant | Mean wall time | Standard deviation |
| --- | ---: | ---: |
${hyperfineRows}
`;

  return `# ${title}

Generated ${generatedAt} on ${hardware}, macOS ${osVersion}.

- Compiler: ${clangVersion}
- Rust: ${rustVersion}
- Zig: ${zigVersion} (ReleaseSafe)
- Nim: ${nimVersion} (ARC release mode)
- Go: ${goVersion}
- Hyperfine: ${hyperfineVersion}
- Z release profile under test: \`clang -O3 -DNDEBUG\`
- Samples: ${samples} measured runs after ${warmups} warmups; table reports the median
- Workloads receive iteration counts at runtime from a separately compiled C helper
- Allocation counts instrument \`malloc\`, \`calloc\`, \`realloc\`, and \`free\` in the benchmark translation unit

## Runtime

Each workload's C, C++, or Z direct-await reference is the \`1.000×\` baseline.

| Workload | Variant | Median | Relative to baseline | Allocation calls/frees (requested bytes) |
| --- | --- | ---: | ---: | ---: |
${rows}
${hyperfineSection}

## Compilation and stripped binary size

| Workload | Variant | Z emit (Bun stage 0) | Native build | Stripped binary |
| --- | --- | ---: | ---: | ---: |
${compilationRows}

## Semantic equivalence

| Workload | Compared contract |
| --- | --- |
${semanticRows}

## Generated-code classification

| Area | Finding | Classification |
| --- | --- | --- |
${classificationRows}

## Scope and interpretation

Rust, Zig, Nim, and Go are included only where their standard operations
preserve the contract in the table above. Missing cells are deliberate, not
zero-cost claims. Allocation instrumentation currently covers the generated Z
and C/C++ translation units; other languages report \`—\` until they have
equivalent allocator-level counters. Swift is not part of this portable-kernel
checkpoint.

The `channel-thread` row deliberately compares Z's suspending producer with
the same blocking native handoff used by the synchronous control. It isolates
the current async task-frame cost; `channel-thread-sync` is the semantics-matched
native ceiling comparison.

This tests Z's current ceiling through generated C/C++ and Clang, not the
debug-oriented \`z run\` profile. Cross-language compilation times include
different amounts of runtime and standard-library work and should not be read
as a frontend-only comparison.

The generated C and optimized assembly used for inspection are reproducible in
\`benchmarks/.build/<case>/z-generated.c\` and \`*.s\`; the build directory is
not committed. Ratios near 1.0 confirm equivalent lowering for that workload.
Larger ratios must be classified as an intentional safety/ownership cost,
current compiler overhead, or a benchmark mismatch before becoming a language
performance claim.
`;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`expected a positive integer, found ${value}`);
  return parsed;
}

function positiveNumber(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`expected a positive number, found ${value}`);
  return parsed;
}

function firstLine(value: string): string {
  return value.trim().split(/\r?\n/, 1)[0] ?? "";
}

function formatNanoseconds(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(3)} s`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(3)} ms`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(3)} µs`;
  return `${value.toFixed(0)} ns`;
}

function formatRatio(value: number): string {
  return `${value.toFixed(3)}×`;
}

function formatBytes(value: number): string {
  return `${(value / 1024).toFixed(1)} KiB`;
}

function formatAllocations(result: VariantResult): string {
  if (!result.allocationsMeasured) return "—";
  return `${result.allocations}/${result.frees} (${formatBytes(result.requestedBytes)})`;
}
