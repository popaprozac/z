// Profile a genuine native frontend rebuild, bypassing executable reuse without
// deleting caches or changing application source. SDK evidence stays warm.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const [driverArgument, projectArgument, overlayArgument, reportArgument] = process.argv.slice(2);
if (!driverArgument || !projectArgument || !overlayArgument || !reportArgument) {
  throw new Error("usage: bun benchmarks/native-emission.ts <native-z> <project> <overlay.zbuild.json|-> <report.json>");
}
const driver = resolve(driverArgument);
const project = resolve(projectArgument);
const report = resolve(reportArgument);
const emitted = report.replace(/\.json$/, "") + ".m";
mkdirSync(dirname(report), { recursive: true });
const args = [driver, "emit", project];
if (overlayArgument !== "-") args.push("--generated", resolve(overlayArgument));
const command = process.platform === "darwin" ? ["/usr/bin/time", "-l", ...args] : args;
const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const compilerHash = hash(driver);
const compilerSourceHash = existsSync(`${driver}.c`) ? hash(`${driver}.c`) : null;
const started = performance.now();
const child = Bun.spawn(command, {
  stdout: Bun.file(emitted), stderr: "pipe", detached: true,
});
let completed = false;
function stop() {
  if (!completed) { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
}
const timeout = setTimeout(stop, 180_000);
process.on("exit", stop);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => { stop(); process.exit(130); });
}
console.error(`[perf] native emission process group ${child.pid}`);
const stderrPromise = new Response(child.stderr).text();
const status = await child.exited;
completed = true;
clearTimeout(timeout);
const seconds = (performance.now() - started) / 1000;
const stderr = await stderrPromise;
if (status !== 0) throw new Error(`native emission failed (${status}): ${stderr}`);
if (hash(driver) !== compilerHash) throw new Error("compiler changed during measurement");
const result = {
  measuredAt: new Date().toISOString(),
  command: args, platform: process.platform, architecture: process.arch,
  compilerHash, compilerSourceHash, seconds, emittedBytes: readFileSync(emitted).byteLength,
  emittedHash: hash(emitted),
  maximumResidentBytes: Number(stderr.match(/(\d+)\s+maximum resident set size/)?.[1]) || null,
  peakFootprintBytes: Number(stderr.match(/(\d+)\s+peak memory footprint/)?.[1]) || null,
  resourceUsage: stderr.trim(),
};
writeFileSync(report, JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result, null, 2));
