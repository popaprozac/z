import {
  assert, cli, compileToC, mkdtempSync, resolve, rmSync, spawnSync, test, writeFileSync,
} from "./support/bootstrap.ts";

function command(executable: string, args: string[], input?: string, timeout = 30_000): string {
  const result = spawnSync(executable, args, {
    input, encoding: "utf8", timeout, killSignal: "SIGKILL", maxBuffer: 32 * 1024 * 1024,
  });
  assert.equal(result.status, 0, `${executable} ${args.join(" ")}\n${result.stderr}\n${result.error ?? ""}`);
  return result.stdout;
}

test("replaces, forwards, and revives ARC output storage in both compilers", () => {
  const directory = mkdtempSync("/tmp/z-out-cleanup-");
  try {
    const input = resolve(directory, "main.zs");
    const source = `import console from "std/console";
      class Item {
        id: i32;
        deinit { console.log(\`\${this.id}\`); }
      }
      function initialize(out value: Item, id: i32): void {
        value = new Item({ id });
      }
      function twice(out value: Item): void {
        value = new Item({ id: 3 });
        value = new Item({ id: 4 });
      }
      function forward(out value: Item): void { twice(out value); }
      function replace(inout value: Item): void { initialize(out value, 7); }
      function consume(value: Item): void { console.log(\`using \${value.id}\`); }
      function replaceAndTest(out value: Item): boolean {
        initialize(out value, 9);
        return true;
      }
      function existing(): void {
        let value = new Item({ id: 1 });
        initialize(out value, 2);
        if (value.id != 2) return;
        forward(out value);
        initialize(out value, 5);
        consume(move value);
        initialize(out value, 6);
        replace(inout value);
        if (false && replaceAndTest(out value)) return;
        if (value.id != 7) return;
        let iteration = 0;
        while (iteration < 2) {
          initialize(out value, 10 + iteration);
          iteration = iteration + 1;
        }
      }
      function fresh(): void {
        let value: Item;
        initialize(out value, 8);
      }
      struct Factory {
        function fill(out value: Item): void {
          value = new Item({ id: 12 });
          value = new Item({ id: 13 });
        }
      }
      type Fill = (out value: Item) => void;
      function invoke(fill: Fill, out value: Item): void { fill(out value); }
      function fillTwice(out target: Item): void {
        target = new Item({ id: 14 });
        target = new Item({ id: 15 });
      }
      function callable(): void {
        let value: Item;
        const factory = Factory();
        factory.fill(out value);
        const fill: Fill = fillTwice;
        invoke(fill, out value);
        if (true && replaceAndTest(out value)) {
          console.log(\`result \${value.id}\`);
        }
      }
      function localCallback(): void {
        const run = (): void => {
          let value: Item;
          initialize(out value, 16);
          consume(move value);
          initialize(out value, 17);
        };
        run();
      }
      function main(): i32 { existing(); fresh(); callable(); localCallback(); return 0; }
    `;
    writeFileSync(input, source);
    const outputs = [
      compileToC(source, input),
      command(process.execPath, [cli, "self-host-emit", input], undefined, 180_000),
    ];
    for (const [compiler, output] of outputs.entries()) {
      for (const optimization of ["-O0", "-O2"]) {
        const executable = resolve(directory, `program-${compiler}`);
        command("clang", ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror",
          optimization, "-fsanitize=undefined", "-fno-sanitize-recover=all", "-", "-o", executable], output);
        assert.equal(command(executable, [], undefined, 5_000),
          "1\n2\n3\n4\nusing 5\n5\n6\n7\n10\n11\n8\n12\n13\n14\n15\nresult 9\n9\nusing 16\n16\n17\n", `${compiler} ${optimization}`);
      }
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 240_000);
