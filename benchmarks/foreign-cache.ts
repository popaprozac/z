// Isolated SDK declaration-cache probe. Never clears an application's caches
// and never builds or launches a GUI. Each import uses a fresh adapter process.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const label = process.argv[2] ?? "sample";
const zapp = resolve(process.argv[3] ?? "../zapp");
const root = resolve(import.meta.dir, "..");
const cache = mkdtempSync("/tmp/z-sdk-cache-bench-");
const log = resolve(root, ".z-cache/benchmarks/foreign-cache.jsonl");
mkdirSync(resolve(root, ".z-cache/benchmarks"), { recursive: true });
const imports = [
  ["AppKit/AppKit.h", "clipboard-backend.zs", "context-menu-backend.zs", "dialog-backend.zs"],
  ["WebKit/WebKit.h", "configured-webview.zs", "document-transport.zs", "configured-smoke.zs"],
];
const active = new Set<ReturnType<typeof spawn>>();
function stopChildren() {
  for (const child of active) {
    try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); }
  }
}
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => { stopChildren(); process.exit(130); });
}
process.on("exit", stopChildren);
function run(args: string[]): Promise<void> {
  return new Promise((accept, reject) => {
    const child = spawn(process.execPath, args, { detached: true, stdio: "inherit" });
    active.add(child);
    const timer = setTimeout(() => {
      try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); }
    }, 120_000);
    child.once("error", (error) => { clearTimeout(timer); active.delete(child); reject(error); });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      active.delete(child);
      if (code === 0) accept();
      else reject(new Error(`adapter failed: status ${code}, signal ${signal}`));
    });
  });
}
try {
  const hashes = new Map<string, string>();
  for (const pass of ["cold", "warm"]) {
    for (const [header, ...modules] of imports) {
      for (const [index, module] of modules.entries()) {
        const source = resolve(zapp, "native/z/framework/platform/macos", module!);
        const output = resolve(cache, `${header!.split("/")[0]}-${index}.zfdcl`);
        const start = performance.now();
        await run([
          resolve(root, "compiler/src/foreign-adapter-cli.ts"),
          source, header!, output, resolve(zapp, "spikes/z-notes/zapp/z.json"),
        ]);
        const seconds = (performance.now() - start) / 1000;
        const digest = createHash("sha256").update(readFileSync(output)).digest("hex");
        const previous = hashes.get(header!);
        if (previous && previous !== digest) throw new Error(`declaration mismatch for ${header}`);
        hashes.set(header!, digest);
        const record = { label, pass, header, module, index, seconds, digest };
        appendFileSync(log, JSON.stringify(record) + "\n");
        console.log(JSON.stringify(record));
      }
    }
  }
} finally {
  rmSync(cache, { recursive: true, force: true });
}
