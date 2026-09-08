// Build-only Z Notes pipeline probe. Does not launch the application or Vite
// dev server. Dev mode requires the existing Vite-produced worker artifact.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const repository = resolve(process.argv[2] ?? "../zapp");
const root = resolve(repository, "spikes/z-notes");
const mode = process.argv[3] ?? "release";
if (mode !== "release" && mode !== "dev") {
  throw new Error("usage: bun benchmarks/profile-zapp-build.ts [zapp-repository] [release|dev] [label]");
}
const runId = process.argv[4] ?? new Date().toISOString();
const log = resolve(import.meta.dir, "../.z-cache/benchmarks/zapp-build.jsonl");
mkdirSync(dirname(log), { recursive: true });
const started = performance.now();
function record(value: object) {
  const entry = { runId, mode, elapsed: (performance.now() - started) / 1000, ...value };
  appendFileSync(log, JSON.stringify(entry) + "\n");
  console.error("[perf]", JSON.stringify(entry));
}

// Observe the real build's subprocesses without changing compiler arguments.
const originalSpawn = Bun.spawn.bind(Bun);
const children = new Set<any>();
Bun.spawn = ((command: any, options: any = {}) => {
  const start = performance.now();
  const child = originalSpawn(command, { ...options, detached: true });
  children.add(child);
  const timer = setTimeout(() => {
    record({ kind: "timeout", command });
    try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
  }, 180_000);
  child.exited.then((status: number) => {
    clearTimeout(timer);
    children.delete(child);
    record({ kind: "command", command, status, seconds: (performance.now() - start) / 1000 });
  });
  return child;
}) as typeof Bun.spawn;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    for (const child of children) {
      try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
    }
    process.exit(130);
  });
}
process.on("exit", () => {
  for (const child of children) {
    try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
  }
});
async function phase<T>(name: string, operation: () => Promise<T>): Promise<T> {
  const start = performance.now();
  const result = await operation();
  record({ kind: "phase", name, seconds: (performance.now() - start) / 1000 });
  return result;
}

process.env.ZAPP_NATIVE_LANG = "z";
process.env.ZAPP_Z_HOST = "desktop";
const { loadConfig, createConfigContext } = await import(repository + "/cli/src/config.ts");
const { prepareZFrontendServices } = await import(repository + "/cli/src/native-z.ts");
const { compileNative } = await import(repository + "/cli/src/native.ts");
const { createDevBundle } = await import(repository + "/cli/src/bundle.ts");
const config = await phase("config", () => loadConfig(root, createConfigContext(root, mode === "dev" ? "dev" : "build", "macos")));
const preparedZServices = await phase("service metadata", () => prepareZFrontendServices({ root, nativeDir: resolve(repository, "native"), config }));
if (mode === "release") {
  await phase("vite build", async () => {
    const child = Bun.spawn(["bunx", "vite", "build"], {
      cwd: root, env: { ...process.env, ZAPP_PROJECT_ROOT: root }, stdout: "inherit", stderr: "inherit",
    });
    if (await child.exited !== 0) throw new Error("vite failed");
  });
}
const output = resolve(root, "build", "zapp-z-webview");
await phase("native pipeline", () => compileNative({
  root, buildFile: "", buildConfigFile: "", nativeDir: resolve(repository, "native"),
  output, optimize: mode === "release", target: "macos", config, preparedZServices,
  ...(mode === "dev" ? { devUrl: "http://localhost:5173" } : {}),
}));
await phase("bundle + ad-hoc sign", () => createDevBundle(root, output, config, { smoke: false }));
record({ kind: "total", seconds: (performance.now() - started) / 1000 });
