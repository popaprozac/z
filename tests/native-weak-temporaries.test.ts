import {
  assert, cli, compileToNative, mkdtempSync, projectRoot, readFileSync,
  resolve, rmSync, spawnSync, test,
} from "./support/bootstrap.ts";

test("transfers fresh weak handles to owned parameters without caller double release", () => {
  const path = resolve(projectRoot, "tests/fixtures/weak-temporary-transfer.zs");
  const source = readFileSync(path, "utf8");
  const directory = mkdtempSync("/tmp/z-weak-temporaries-");
  try {
    const native = spawnSync(process.execPath, [cli, "self-host-emit", path], {
      encoding: "utf8", timeout: 180_000, killSignal: "SIGKILL", maxBuffer: 24 * 1024 * 1024,
    });
    assert.equal(native.status, 0, native.stderr || String(native.error ?? native.signal));
    const sources = [
      ["native", native.stdout],
      ["stage0", compileToNative(source, path).source],
    ] as const;
    for (const [frontend, emitted] of sources) {
      // A live strong owner keeps one implicit weak count. Catch losing that
      // count before free, deterministically and without depending on malloc
      // reuse, ASan, WebKit, or a process-exit heap-corruption report.
      const release = "static inline __attribute__((unused)) void z_weak_release(Z_Weak value) {";
      assert.ok(emitted.includes(release), frontend);
      const checked = emitted.replace(release, release + "\n"
        + "  if (value.control != NULL && value.control->value != NULL && value.control->weak_count <= 1) abort();\n");
      for (const optimization of ["-O0", "-O2"]) {
        const binary = resolve(directory, frontend + optimization);
        const compiled = spawnSync("clang", ["-x", "c", "-std=c11", optimization, "-Wall", "-Wextra", "-Werror",
          "-fsanitize=undefined", "-fno-sanitize-recover=all", "-", "-o", binary], {
          input: checked, encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL",
        });
        assert.equal(compiled.status, 0, compiled.stderr || String(compiled.error ?? compiled.signal));
        const result = spawnSync(binary, [], { encoding: "utf8", timeout: 5000, killSignal: "SIGKILL" });
        assert.equal(result.status, 0,
          `${frontend} ${optimization}: ${result.stderr || String(result.error ?? result.signal)}`);
        assert.equal(result.stdout, "released item\n");
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 240_000);
