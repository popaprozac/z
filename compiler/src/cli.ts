#!/usr/bin/env bun

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { check, compileToC } from "./compiler.ts";

const [command, inputArgument] = process.argv.slice(2);

if (!command || !inputArgument || !["check", "emit", "run"].includes(command)) {
  usage();
  process.exitCode = 2;
} else {
  const inputPath = resolve(inputArgument);
  try {
    const source = readFileSync(inputPath, "utf8");
    if (command === "check") {
      check(source, inputPath);
      console.log(`${inputPath}: ok`);
    } else {
      const generated = compileToC(source, inputPath);
      if (command === "emit") {
        process.stdout.write(generated);
      } else {
        runNative(inputPath, generated);
      }
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

function runNative(inputPath: string, generated: string): void {
  const projectRoot = resolve(dirname(new URL(import.meta.url).pathname), "../..");
  const cacheDirectory = join(projectRoot, ".z-cache");
  mkdirSync(cacheDirectory, { recursive: true });
  const stem = basename(inputPath).replace(/\.z$/, "");
  const cPath = join(cacheDirectory, `${stem}.c`);
  const executablePath = join(cacheDirectory, stem);
  writeFileSync(cPath, generated);

  const compilation = spawnSync("clang", [
    "-std=c11",
    "-Wall",
    "-Wextra",
    "-Werror",
    cPath,
    "-o",
    executablePath,
  ], { encoding: "utf8" });
  if (compilation.status !== 0) {
    throw new Error(compilation.stderr || "Clang failed");
  }

  const execution = spawnSync(executablePath, [], { encoding: "utf8" });
  process.stdout.write(execution.stdout);
  process.stderr.write(execution.stderr);
  if (execution.status !== 0) process.exitCode = execution.status ?? 1;
}

function usage(): void {
  console.error("usage: z <check|emit|run> <file.z>");
}
