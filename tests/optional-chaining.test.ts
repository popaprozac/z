import {
  assert,
  compileToNative,
  diagnostics,
  hostToolchainTest,
  mkdtempSync,
  resolve,
  spawnSync,
  test,
  writeFileSync,
  cli,
} from "./support/bootstrap.ts";

function runSource(source: string, name: string) {
  const directory = mkdtempSync("/tmp/z-optional-chain-");
  const fileName = resolve(directory, name);
  writeFileSync(fileName, source);
  return spawnSync(process.execPath, [cli, "run", fileName], { encoding: "utf8" });
}

hostToolchainTest("short-circuits Option fields and methods with one receiver evaluation", () => {
  const source = `
    import console from "std/console";

    struct Display {
      scale: i32;
    }

    struct Window {
      display: Option<Display>;

      function currentDisplay(): Option<Display> {
        return this.display;
      }

      function announce(): void {
        console.log("announced");
      }
    }

    function findWindow(): Option<Window> {
      console.log("looked up");
      return Option<Window>.some(Window({
        display: Option<Display>.some(Display({ scale: 42 })),
      }));
    }

    function main(): i32 {
      const scale = findWindow()?.currentDisplay()?.scale;
      const missing = Option<Window>.none;
      missing?.announce();
      return match (scale) {
        some(value) => value - 42;
        none => 1;
      };
    }
  `;
  const result = runSource(source, "short-circuit.zs");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "looked up\n");
});

hostToolchainTest("projects cleanup-bearing fields as owner-tied optional views", () => {
  const source = `
    struct Document {
      title: String;
    }

    struct Library {
      document: Document;
    }

    function main(): i32 {
      const library = Option<Library>.some(Library({
        document: Document({ title: "hello" }),
      }));
      const document = library?.document;
      const title = library?.document?.title;
      const documentBytes = match (in document) {
        some(value) => i32(value.title.byteLength) - 5;
        none => 1;
      };
      const titleBytes = match (in title) {
        some(value) => i32(value.byteLength) - 5;
        none => 1;
      };
      return documentBytes + titleBytes;
    }
  `;
  const fileName = "/tmp/z-optional-chain-view.zs";
  const artifact = compileToNative(source, fileName);
  assert.match(artifact.source, /Z_Document \* const document|Z_Option___z_view_3a_Document/);
  const result = runSource(source, "view.zs");
  assert.equal(result.status, 0, result.stderr);
});

hostToolchainTest("keeps fresh owned results owned and flattens existing Option results", () => {
  const source = `
    struct Maker {
      id: i32;

      function label(): String {
        return \`value-\${this.id}\`;
      }

      function maybeId(): Option<i32> {
        return Option<i32>.some(this.id);
      }
    }

    function main(): i32 {
      const maker = Option<Maker>.some(Maker({ id: 42 }));
      const label = maker?.label();
      const id = maker?.maybeId();
      const length = match (label) {
        some(value) => i32(value.byteLength);
        none => 0;
      };
      return match (id) {
        some(value) => value + length - 50;
        none => 1;
      };
    }
  `;
  const result = runSource(source, "owned-and-flat.zs");
  assert.equal(result.status, 0, result.stderr);
});

hostToolchainTest("requires a stable named owner for view-returning methods", () => {
  const source = `
    struct Book {
      title: String;
    }

    struct Shelf {
      book: Book;

      function current(): view Book {
        return this.book;
      }
    }

    function makeShelf(): Option<Shelf> {
      return Option<Shelf>.some(Shelf({
        book: Book({ title: \`hello\` }),
      }));
    }

    function main(): i32 {
      const shelf = makeShelf();
      const book = shelf?.current();
      return match (in book) {
        some(value) => i32(value.title.byteAt(0)) - 104;
        none => 1;
      };
    }
  `;
  const result = runSource(source, "view-returning-method.zs");
  assert.equal(result.status, 0, result.stderr);

  const temporary = source.replace(
    "const shelf = makeShelf();\n      const book = shelf?.current();",
    "const book = makeShelf()?.current();",
  );
  const diagnostic = diagnostics(
    temporary,
    "/tmp/z-optional-chain-temporary-view-method.zs",
  )[0];
  assert.equal(diagnostic?.code, "Z0206");
  assert.match(
    diagnostic?.message ?? "",
    /a view-returning optional method requires a named owner binding/,
  );
});

test("rejects optional chains anywhere along an assignment storage path", () => {
  const prefix = `
    struct Child {
      name: i32;
    }

    struct Container {
      child: Child;
    }
  `;
  const direct = `${prefix}
    function main(): i32 {
      let value = Option<Container>.some(Container({
        child: Child({ name: 20 }),
      }));
      value?.child = Child({ name: 22 });
      return 0;
    }
  `;
  const nested = `${prefix}
    function main(): i32 {
      let value = Option<Container>.some(Container({
        child: Child({ name: 20 }),
      }));
      value?.child.name = 22;
      return 0;
    }
  `;
  for (const [name, source] of [["direct", direct], ["nested", nested]] as const) {
    const diagnostic = diagnostics(
      source,
      `/tmp/z-optional-chain-${name}-assignment.zs`,
    )[0];
    assert.equal(diagnostic?.code, "Z0206");
    assert.match(
      diagnostic?.message ?? "",
      /optional chaining is never an assignment target/,
    );
  }
});

hostToolchainTest("preserves throwing calls beneath try and attempt", () => {
  const source = `
    struct LoadError {
      code: i32;
    }

    struct Loader {
      value: i32;

      function load(shouldFail: boolean): i32 throws LoadError {
        if (shouldFail) throw LoadError({ code: 7 });
        return this.value;
      }
    }

    function read(in source: Option<Loader>, shouldFail: boolean): i32 throws LoadError {
      const loaded = try source?.load(shouldFail);
      return match (loaded) {
        some(value) => value;
        none => 0;
      };
    }

    function main(): i32 {
      const source = Option<Loader>.some(Loader({ value: 42 }));
      const success = attempt read(source, false);
      const failure = attempt read(source, true);
      const value = match (success) {
        success(loaded) => loaded;
        failure(error) => 0;
      };
      return match (failure) {
        success(loaded) => 1;
        failure(error) => value - error.code - 35;
      };
    }
  `;
  const result = runSource(source, "throwing.zs");
  assert.equal(result.status, 0, result.stderr);

  const unhandled = source.replace(
    "const loaded = try source?.load(shouldFail);",
    "const loaded = source?.load(shouldFail);",
  );
  assert.match(
    diagnostics(unhandled, "/tmp/z-optional-chain-unhandled.zs")[0]?.message ?? "",
    /throwing call requires `attempt` or `try`/,
  );
});

test("rejects mutable and consuming methods through optional chaining", () => {
  const prefix = `
    struct Resource {
      value: i32;

      function update(inout this): void {
        this.value = this.value + 1;
      }

      function finish(move this): i32 {
        return this.value;
      }
    }
  `;
  const mutable = `${prefix}
    function main(): i32 {
      let resource = Option<Resource>.some(Resource({ value: 1 }));
      resource?.update();
      return 0;
    }
  `;
  const consuming = `${prefix}
    function main(): i32 {
      const resource = Option<Resource>.some(Resource({ value: 1 }));
      return match (resource?.finish()) {
        some(value) => value;
        none => 0;
      };
    }
  `;
  assert.match(
    diagnostics(mutable, "/tmp/z-optional-chain-mutable.zs")[0]?.message ?? "",
    /mutable method "update" cannot be called through optional chaining[\s\S]*use `match \(in value\)/,
  );
  assert.match(
    diagnostics(consuming, "/tmp/z-optional-chain-consuming.zs")[0]?.message ?? "",
    /consuming method "finish" cannot be called through optional chaining[\s\S]*use `match \(in value\)/,
  );
});

hostToolchainTest("short-circuits nullable Objective-C references", () => {
  if (process.platform !== "darwin") return;
  const source = `
    import AppKit from "AppKit/AppKit.h";

    function main(): i32 {
      const app = AppKit.NSApplication.sharedApplication;
      const window = app.keyWindow;
      const visible = window?.visible;
      return match (visible) {
        some(value) => 0;
        none => 0;
      };
    }
  `;
  const artifact = compileToNative(source, "/tmp/z-optional-chain-objc.zs");
  assert.match(artifact.source, /if \(window != nil\)/);
  assert.match(artifact.source, /\[window isVisible\]/);
});
