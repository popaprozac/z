#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

const projectRoot = resolve(import.meta.dir, "..");
const [requestedOutput, ...unexpected] = process.argv.slice(2);

if (unexpected.length > 0) {
  console.error("usage: bun run bootstrap [output]");
  process.exit(2);
}

const outputPath = requestedOutput
  ? resolve(requestedOutput)
  : join(projectRoot, ".z-cache", "bootstrap", executableName("z"));
const outputDirectory = dirname(outputPath);
const standardLibraryPath = join(outputDirectory, "stdlib");
const stageDirectory = (() => {
  mkdirSync(outputDirectory, { recursive: true });
  cpSync(join(projectRoot, "stdlib"), standardLibraryPath, {
    recursive: true,
    force: true,
  });
  return mkdtempSync(join(outputDirectory, ".z-bootstrap-"));
})();

try {
  const cliPath = join(projectRoot, "compiler", "src", "cli.ts");
  const foreignAdapterCliPath = join(
    projectRoot,
    "compiler",
    "src",
    "foreign-adapter-cli.ts",
  );
  const driverPath = join(projectRoot, "compiler", "driver", "main.zs");
  const seedCPath = join(stageDirectory, "z-seed.c");
  const generationOnePath = join(
    stageDirectory,
    executableName("z-generation-one"),
  );
  const generationTwoPath = join(
    stageDirectory,
    executableName("z-generation-two"),
  );
  const foreignAdapterPath = join(
    stageDirectory,
    executableName("z-foreign-adapter"),
  );

  const seedEmission = spawnSync(
    process.execPath,
    [cliPath, "self-host-emit", driverPath],
    {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  requireSuccess(seedEmission, "the bootstrap seed could not emit native Z");
  writeFileSync(seedCPath, seedEmission.stdout);

  const seedCompilation = spawnSync(
    "clang",
    [
      "-x",
      "c",
      "-std=c11",
      "-O2",
      "-DNDEBUG",
      "-Wall",
      "-Wextra",
      "-Werror",
      seedCPath,
      "-o",
      generationOnePath,
    ],
    { encoding: "utf8" },
  );
  requireSuccess(seedCompilation, "Clang could not build bootstrap generation one");

  const recursiveBuild = spawnSync(
    generationOnePath,
    ["build", driverPath, generationTwoPath, "--release"],
    {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  requireSuccess(
    recursiveBuild,
    "bootstrap generation one could not build generation two",
  );

  const seedC = readFileSync(seedCPath);
  const generationTwoCPath = `${generationTwoPath}.c`;
  const generationTwoC = readFileSync(generationTwoCPath);
  if (!seedC.equals(generationTwoC)) {
    const difference = firstDifference(seedC, generationTwoC);
    throw new Error(
      "native bootstrap fixed-point mismatch: "
        + `seed ${digest(seedC)}, generation two ${digest(generationTwoC)}, `
        + `first differing byte ${difference}`,
    );
  }

  const adapterCompilation = spawnSync(
    process.execPath,
    [
      "build",
      foreignAdapterCliPath,
      "--compile",
      "--outfile",
      foreignAdapterPath,
    ],
    { encoding: "utf8" },
  );
  requireSuccess(
    adapterCompilation,
    "Bun could not package the foreign metadata adapter",
  );

  const pendingOutputPath = `${outputPath}.pending`;
  const finalCPath = `${outputPath}.c`;
  const pendingCPath = `${finalCPath}.pending`;
  const finalAdapterPath = join(
    outputDirectory,
    executableName("z-foreign-adapter"),
  );
  const pendingAdapterPath = `${finalAdapterPath}.pending`;
  copyFileSync(foreignAdapterPath, pendingAdapterPath);
  chmodSync(pendingAdapterPath, 0o755);
  renameSync(pendingAdapterPath, finalAdapterPath);
  copyFileSync(generationTwoPath, pendingOutputPath);
  chmodSync(pendingOutputPath, 0o755);
  copyFileSync(generationTwoCPath, pendingCPath);
  renameSync(pendingCPath, finalCPath);
  renameSync(pendingOutputPath, outputPath);

  console.log(
    `bootstrapped fixed-point native z (${generationTwoC.length} C bytes)`,
  );
  console.log(`packaged adjacent foreign adapter at ${finalAdapterPath}`);
  console.log(outputPath);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  rmSync(stageDirectory, { recursive: true, force: true });
}

function executableName(name: string): string {
  return process.platform === "win32" ? `${name}.exe` : name;
}

function requireSuccess(
  result: ReturnType<typeof spawnSync>,
  fallback: string,
): void {
  if (result.error) throw result.error;
  if (result.status === 0) return;
  const stderr = result.stderr?.toString().trim();
  throw new Error(stderr || `${fallback} (status ${result.status ?? "unknown"})`);
}

function digest(contents: Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}

function firstDifference(left: Buffer, right: Buffer): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) return index;
  }
  return length;
}
