import { tmpdir } from "node:os";
import { symlinkSync } from "node:fs";
import { assert, cli, compileToNative, hostToolchainTest, mkdtempSync, projectRoot,
  resolve, resolveForeignFunctionDeclarationStreams, rmSync, spawnSync, writeFileSync } from "./support/bootstrap.ts";

function command(executable: string, args: string[], input?: string, timeout = 30_000): string {
  const result = spawnSync(executable, args, {
    encoding: "utf8", input, timeout, killSignal: "SIGKILL", maxBuffer: 24 * 1024 * 1024,
  });
  assert.equal(result.status, 0,
    `${executable} ${args.join(" ")}\n${result.stderr}\n${result.stdout.slice(-4_000)}\n${result.error ?? ""}`);
  return result.stdout;
}

const declarations = `import console from "std/console";
class Item {
  id: i32;
  deinit { console.log(\`\${this.id}\`); }
}
class Holder { item: Item; }
class Snapshot<T> { value: T; }
type Document = Item;
function same(in left: Item, in right: Document): boolean { return left == right; }
function make(id: i32): Item { console.log(\`\${id + 100}\`); return new Item({ id }); }
function holder(): Holder { return new Holder({ item: new Item({ id: 99 }) }); }
function exchange(inout current: Item): Item {
  const former = current;
  current = new Item({ id: 13 });
  return former;
}
function borrow(in current: Item): Item { return current; }
function transfer(current: Item): Item { return move current; }
`;

hostToolchainTest("compares class identity without consuming owners and cleans conditional temporaries in both emitters", () => {
  const temporary = mkdtempSync(resolve(tmpdir(), "z-reference-identity-"));
  try {
    const input = resolve(temporary, "main.zs");
    const seed = command(process.execPath, [cli, "self-host-emit", resolve(projectRoot,
      "tests/fixtures/self-host-objc-header-composition.zs")], undefined, 180_000);
    const oracle = resolve(temporary, "emitter");
    command("clang", ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", oracle], seed, 60_000);
    for (const async of [false, true]) {
      const source = declarations + `${async ? "async " : ""}function main(): i32 {
        const first = new Item({ id: 1 });
        const alias = first;
        const other = new Item({ id: 2 });
        if (!same(first, alias) || first != alias || first == other) return 1;
        if (first.id != 1 || alias.id != 1 || other.id != 2) return 2;
        if (make(3) == make(4)) return 3;
        if (false && make(5) == make(6)) return 4;
        if (!(true || make(7) == make(8))) return 5;
        if (first == make(9)) return 6;
        const last = new Item({ id: 10 });
        if (move last == alias) return 7;
        const snapshot = new Snapshot<i32>({ value: 42 });
        const sameSnapshot = snapshot;
        if (snapshot != sameSnapshot) return 8;
        const stored = new Holder({ item: first });
        if (stored.item != alias) return 10;
        let iterations: i32 = 0;
        while (iterations < 2 && make(11) != first) { iterations = iterations + 1; }
        if (iterations != 2) return 11;
        let current = new Item({ id: 12 });
        if (current != exchange(inout current)) return 12;
        if (current.id != 13) return 13;
        const initialized = new Item({ id: 14 });
        const borrowed = borrow(initialized);
        const transferred = transfer(move initialized);
        if (borrowed != transferred || borrowed.id != 14) return 14;
        return 0;
      }`;
      writeFileSync(input, source);
      const outputs = [compileToNative(source, input).source, command(oracle, [temporary, input], undefined, 30_000)];
      for (const output of outputs) {
        // Named borrowed references need no ownership wrappers.
        const sameBody = output.match(/\bsame\([^;{}]*?\)\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";
        assert.match(sameBody, /left\)? == \(?\*?right/);
        assert.doesNotMatch(sameBody, /_retain\(|_release\(/);
        const generated = resolve(temporary, "main.c");
        writeFileSync(generated, output);
        for (const optimization of ["-O0", "-O2"]) {
          const executable = resolve(temporary, "probe");
          command("clang", [optimization, "-std=c11", "-Wall", "-Wextra", "-Werror",
            "-fsanitize=undefined", "-fno-sanitize-recover=all", generated, "-o", executable]);
          assert.equal(command(executable, [], undefined, 5_000), "103\n104\n4\n3\n109\n9\n10\n111\n11\n111\n11\n12\n14\n13\n2\n1\n");
        }
      }
    }
    for (const body of [
      "const a = new Item({ id: 1 }); const b = new Other({ id: 1 }); return a == b;",
      "const a = new Item({ id: 1 }); return a < a;",
      "const a = new Item({ id: 1 }); return a == null;",
      "const a = new Item({ id: 1 }); const b = move a; return a == b;",
      "const a = Value({ id: 1 }); return a == a;",
      "const a = new Item({ id: 1 }); return holder().item == a;",
    ]) {
      const source = declarations + `class Other { id: i32; } struct Value { id: i32; }
        function invalid(): boolean { ${body} } function main(): i32 { return 0; }`;
      assert.throws(() => compileToNative(source, input), /operands|moved|consumed|temporary must be bound/);
      writeFileSync(input, source);
      const result = spawnSync(oracle, [temporary, input], { encoding: "utf8", timeout: 15_000, killSignal: "SIGKILL" });
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /operands|moved|consumed|temporary must be bound/);
    }
    if (process.platform === "darwin") {
      const fixtures = resolve(projectRoot, "tests/fixtures");
      symlinkSync(resolve(fixtures, "reference-identity.h"), resolve(temporary, "reference-identity.h"));
      writeFileSync(resolve(temporary, "reference-identity.h.zd"), 'declare module "./reference-identity.h" {}');
      writeFileSync(resolve(temporary, "reference-identity.h.zfdcl"), resolveForeignFunctionDeclarationStreams([{
        kind: "import", moduleName: "native", bindings: null, header: "./reference-identity.h",
        location: { fileName: input, offset: 0, line: 1, column: 1 },
      }], input, [fixtures]).values().next().value!);
      const imports = 'import native from "./reference-identity.h";\n';
      const source = imports + `
        function same(in left: native.ZIdentityObject, in right: native.ZIdentityObject): boolean { return left == right; }
        function check(): i32 {
          const first = native.z_identity_make(1);
          const alias = first;
          const other = native.z_identity_make(1);
          if (!same(first, alias) || first != alias || first == other || !(first != other)) return 1;
          const present = native.z_identity_optional(first, true);
          const absent = native.z_identity_optional(first, false);
          if (present != first || first != present || absent == first || absent != null) return 2;
          if (present == absent || absent != native.z_identity_optional(first, false)) return 3;
          const base = native.z_identity_base(first);
          const erased = native.z_identity_erased(first);
          if (base != first || first != base || erased != first || first != erased) return 4;
          const child = native.ZIdentityChild.alloc().initWithValue(2);
          if (child == first || first == child) return 5;
          if (native.z_identity_make(3) == native.z_identity_make(4)) return 6;
          if (false && native.z_identity_make(5) == first) return 7;
          if (first.value != 1 || alias.value != 1) return 8;
          return native.z_identity_equal_calls();
        }
        function main(): i32 {
          const result = check();
          if (result != 0) return result;
          return native.z_identity_live();
        }
      `;
      writeFileSync(input, source);
      for (const output of [compileToNative(source, input).source, command(oracle, [temporary, input])]) {
        assert.doesNotMatch(output, /isEqual:/);
        const generated = resolve(temporary, "main.m");
        writeFileSync(generated, output);
        for (const optimization of ["-O0", "-O2"]) {
          const executable = resolve(temporary, "objc-probe");
          command("clang", [optimization, "-fobjc-arc", "-Wall", "-Wextra", "-Werror",
            "-fsanitize=undefined", "-fno-sanitize-recover=all", "-I", fixtures, "-framework", "Foundation",
            generated, resolve(fixtures, "reference-identity.m"), "-o", executable]);
          command(executable, [], undefined, 5_000);
        }
      }
      for (const expression of [
        "native.z_identity_make(1) == native.ZIdentityUnrelated.new()",
        "native.z_identity_make(1) == new Item({ id: 1 })",
        'native.NSString.stringWithUTF8String("same") == "same"',
      ]) {
        const rejected = imports + declarations + `function main(): i32 { if (${expression}) return 1; return 0; }`;
        assert.throws(() => compileToNative(rejected, input), /operands/);
        writeFileSync(input, rejected);
        const result = spawnSync(oracle, [temporary, input], { encoding: "utf8", timeout: 15_000, killSignal: "SIGKILL" });
        assert.equal(result.status, 1, `${expression}: ${result.stderr}\n${result.stdout.split("\n").filter(line => line.includes("_z_identity") || line.includes("ZIdentityUnrelated")).join("\n")}`);
        assert.match(result.stderr, /operands/, expression);
      }
    }
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}, 240_000);
