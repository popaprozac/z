import {
  assert,
  compileToC,
  diagnostics,
  hostToolchainTest,
  mkdtempSync,
  rmSync,
  resolve,
  spawnSync,
  test,
  writeFileSync,
  cli,
} from "./support/bootstrap.ts";

function runSource(source: string, name: string) {
  const directory = mkdtempSync("/tmp/z-struct-spread-");
  const fileName = resolve(directory, name);
  writeFileSync(fileName, source);
  return spawnSync(process.execPath, [cli, "run", fileName], { encoding: "utf8" });
}

hostToolchainTest("spreads ordinary fields and preserves direct optional overrides", () => {
  const source = `
    struct RequestOptions {
      timeoutMilliseconds: i32 = 1000;
      retries: i32 = 2;
      parent?: i32;
    }

    function main(): i32 {
      const incoming = RequestOptions({
        timeoutMilliseconds: 2000,
        retries: 3,
        parent: 40,
      });
      const updated = RequestOptions({
        ...incoming,
        timeoutMilliseconds: 42,
      });
      const parent = match (in updated.parent) {
        some(value) => value;
        none => 100;
      };
      return updated.timeoutMilliseconds + updated.retries + parent - 85;
    }
  `;
  const result = runSource(source, "ordinary.zs");
  assert.equal(result.status, 0, result.stderr);
});

hostToolchainTest("does not evaluate field defaults again when a spread supplies them", () => {
  const source = `
    import console from "std/console";

    function defaultTimeout(): i32 {
      console.log("default timeout");
      return 1000;
    }

    struct RequestOptions {
      timeoutMilliseconds: i32 = defaultTimeout();
      retries: i32 = 2;
    }

    function main(): i32 {
      const incoming = RequestOptions();
      const updated = RequestOptions({
        ...incoming,
        retries: 3,
      });
      return updated.timeoutMilliseconds - 1000;
    }
  `;
  const result = runSource(source, "defaults-once.zs");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "default timeout\n");
});

hostToolchainTest("copies only retained fields and ignores overridden move-only fields", () => {
  const source = `
    import console from "std/console";

    struct Resource {
      id: i32;

      deinit {
        console.log(\`released \${this.id}\`);
      }
    }

    struct Snapshot {
      title: String;
      resource: Resource;
    }

    function main(): i32 {
      const original = Snapshot({
        title: "draft",
        resource: Resource({ id: 1 }),
      });
      const copied = Snapshot({
        copy ...original,
        resource: Resource({ id: 2 }),
      });
      return i32(copied.title.byteLength) - i32(original.title.byteLength);
    }
  `;
  const result = runSource(source, "copy-retained.zs");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "released 2\nreleased 1\n");
});

hostToolchainTest("ordinary spread retains shared class identity", () => {
  const source = `
    import console from "std/console";

    class Session {
      id: i32;

      deinit {
        console.log(\`released session \${this.id}\`);
      }
    }

    struct Window {
      session: Session;
      width: i32;
    }

    function main(): i32 {
      const original = Window({
        session: new Session({ id: 42 }),
        width: 800,
      });
      const resized = Window({
        ...original,
        width: 1200,
      });
      return resized.session.id - original.session.id;
    }
  `;
  const result = runSource(source, "shared-identity.zs");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "released session 42\n");
});

hostToolchainTest("captures a spread source through an ordinary closure", () => {
  const source = `
    struct Pair {
      first: i32;
      second: i32;
    }

    function main(): i32 {
      const original = Pair({ first: 20, second: 22 });
      const build = (): Pair => Pair({
        ...original,
        first: 21,
      });
      const updated = build();
      return updated.first + updated.second - 43;
    }
  `;
  const result = runSource(source, "closure-capture.zs");
  assert.equal(result.status, 0, result.stderr);
});

hostToolchainTest("moves retained fields and destroys overridden source fields exactly once", () => {
  const source = `
    import console from "std/console";

    struct Resource {
      id: i32;

      deinit {
        console.log(\`released \${this.id}\`);
      }
    }

    struct Bundle {
      retained: Resource;
      replaced: Resource;
    }

    function main(): i32 {
      const original = Bundle({
        retained: Resource({ id: 1 }),
        replaced: Resource({ id: 2 }),
      });
      const installed = Bundle({
        move ...original,
        replaced: Resource({ id: 3 }),
      });
      console.log(installed.retained.id);
      return installed.replaced.id - 3;
    }
  `;
  const result = runSource(source, "move-cleanup.zs");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "released 2\n1\nreleased 3\nreleased 1\n");
});

hostToolchainTest("preserves exact generic specialization across source modules", () => {
  const directory = mkdtempSync("/tmp/z-struct-spread-modules-");
  const model = resolve(directory, "model.zs");
  const main = resolve(directory, "main.zs");
  writeFileSync(model, `
    export struct Envelope<T> {
      value: T;
      revision: i32;
    }
  `);
  writeFileSync(main, `
    import { Envelope } from "./model.zs";

    function main(): i32 {
      const incoming = Envelope<i32>({ value: 40, revision: 1 });
      const updated = Envelope({
        ...incoming,
        revision: 2,
      });
      return updated.value + updated.revision - 42;
    }
  `);
  const result = spawnSync(process.execPath, [cli, "run", main], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const parity = spawnSync(
    process.execPath,
    [cli, "check", main, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(parity.status, 0, parity.stderr);
  rmSync(directory, { recursive: true, force: true });
}, 20_000);

test("diagnoses unsafe or ambiguous struct spread shapes", () => {
  const useAfterMove = `
    struct Owned { text: String; }
    function main(): i32 {
      const source = Owned({ text: "hello" });
      const moved = Owned({ move ...source });
      return i32(source.text.byteLength) + i32(moved.text.byteLength);
    }
  `;
  assert.match(
    diagnostics(useAfterMove, "spread-use-after-move.zs")[0]?.message ?? "",
    /moved value "source"/,
  );

  const retainedOwned = `
    struct Owned { text: String; count: i32; }
    function main(): i32 {
      const source = Owned({ text: "hello", count: 1 });
      const updated = Owned({ ...source, count: 2 });
      return updated.count;
    }
  `;
  assert.match(
    diagnostics(retainedOwned, "spread-owned.zs")[0]?.message ?? "",
    /ordinary spread cannot implicitly duplicate ownership-bearing field "text"/,
  );

  const copiedIdentity = `
    class Session { id: i32; }
    struct Window { session: Session; width: i32; }
    function main(): i32 {
      const source = Window({
        session: new Session({ id: 1 }),
        width: 800,
      });
      const copied = Window({ copy ...source, width: 1200 });
      return copied.width;
    }
  `;
  assert.match(
    diagnostics(copiedIdentity, "spread-copy-identity.zs")[0]?.message ?? "",
    /retained field "session".*cannot be explicitly copied/,
  );

  const wrongType = `
    struct First { value: i32; }
    struct Second { value: i32; }
    function main(): i32 {
      const source = First({ value: 1 });
      const result = Second({ ...source });
      return result.value;
    }
  `;
  assert.match(
    diagnostics(wrongType, "spread-nominal.zs")[0]?.message ?? "",
    /requires the exact same nominal struct type/,
  );

  const wrongSpecialization = `
    struct Envelope<T> { value: T; }
    function main(): i32 {
      const source = Envelope<i32>({ value: 1 });
      const result = Envelope<i64>({ ...source });
      return 0;
    }
  `;
  assert.match(
    diagnostics(wrongSpecialization, "spread-specialization.zs")[0]?.message ?? "",
    /requires the exact same nominal struct type/,
  );

  const late = `
    struct Pair { first: i32; second: i32; }
    function main(): i32 {
      const source = Pair({ first: 1, second: 2 });
      const result = Pair({ first: 3, ...source });
      return result.first;
    }
  `;
  assert.match(
    diagnostics(late, "spread-order.zs")[0]?.message ?? "",
    /must be the first entry and only one spread is allowed/,
  );

  const generated = compileToC(`
    struct Pair { first: i32; second: i32; }
    function main(): i32 {
      const source = Pair({ first: 20, second: 22 });
      const result = Pair({ ...source, first: 21 });
      return result.first + result.second - 43;
    }
  `, "spread-c.zs");
  assert.match(generated, /\.first = _z_spread_field_/);
  assert.match(generated, /\.second = \(source\)\.second/);
});

test("checks struct spread in async source before deferring task-frame lowering", () => {
  const source = `
    struct Pair { first: i32; second: i32; }
    async function update(): i32 {
      const source = Pair({ first: 20, second: 22 });
      const result = Pair({ ...source, first: 21 });
      return result.first + result.second;
    }
    function main(): i32 { return 0; }
  `;
  assert.deepEqual(diagnostics(source, "spread-async.zs"), []);
  assert.throws(
    () => compileToC(source, "spread-async.zs"),
    /struct spread is not executable in Phase 1 async frames yet/,
  );
});
