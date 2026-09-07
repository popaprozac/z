import {
  assert,
  cli,
  compileToC,
  completions,
  diagnostics,
  hover,
  mkdtempSync,
  projectRoot,
  readFileSync,
  resolve,
  rmSync,
  spawnSync,
  test,
  writeFileSync,
} from "./support/bootstrap.ts";

test("preserves owned Mutex results, callback effects, and exactly-once cleanup", () => {
  const file = resolve(projectRoot, "tests/fixtures/self-host-emit-mutex-owned-result.zs");
  const source = readFileSync(file, "utf8");
  assert.deepEqual(diagnostics(source, file), []);
  const generated = compileToC(source, file);
  // The inferred Array result must use its checked type rather than the
  // fallback i32 used for an unrecognized method call.
  assert.match(generated, /Z_DynamicArray_\w+ names = z_mutex_with_lock_/);
  const result = spawnSync(process.execPath, [cli, "run", file], {
    encoding: "utf8",
    timeout: 30_000,
    killSignal: "SIGKILL",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, [
    "released parcel first",
    "released parcel temporary",
    "released error unavailable",
    "released parcel temporary",
    "released error ready",
    "released error ready",
    "released parcel propagated",
    "released error ready",
    "released snapshot ready",
    "released parcel remaining",
    "",
  ].join("\n"));
}, 60_000);

test("reads and mutates Mutex values through scoped synchronous closures", () => {
  const directory = mkdtempSync("/tmp/z-mutex-scoped-access-");
  const file = resolve(directory, "main.zs");
  try {
    const source = `
      import { Mutex } from "std/sync";

      struct Counter {
        value: i32;
      }

      function main(): i32 {
        const counter = Mutex(Counter({ value: 40 }));
        const before = counter.withLock(
          (in value): i32 => value.value
        );
        counter.withLock((inout value): void => {
          value.value = value.value + 2;
        });
        const after = counter.withLock(
          (in value): i32 => value.value
        );
        return before - 40 + after - 42;
      }
    `;
    writeFileSync(file, source);

    const generated = compileToC(source, file);
    assert.match(generated, /Mutex/);
    assert.match(generated, /(?:pthread_mutex_lock|mtx_lock)/);
    assert.match(generated, /(?:pthread_mutex_unlock|mtx_unlock)/);

    const result = spawnSync(process.execPath, [cli, "run", file], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);

    const native = spawnSync(
      process.execPath,
      [cli, "check", file, "--native-frontend"],
      { encoding: "utf8" },
    );
    assert.equal(native.status, 0, native.stderr);
    assert.match(
      native.stdout,
      /native frontend hybrid exports [1-9]\d* expression type contracts/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 15_000);

test("returns independent owned values from Mutex.withLock", () => {
  const directory = mkdtempSync("/tmp/z-mutex-owned-result-");
  const file = resolve(directory, "main.zs");
  try {
    const source = `
      import { Mutex } from "std/sync";

      struct State {
        title: String;
      }

      function snapshot(in state: Mutex<State>): String {
        return state.withLock(
          (in value): String => copy value.title
        );
      }

      function main(): i32 {
        const state = Mutex(State({ title: "ready" }));
        const title = snapshot(in state);
        return i32(title.byteLength) - 5;
      }
    `;
    writeFileSync(file, source);

    const result = spawnSync(process.execPath, [cli, "run", file], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("preserves Mutex payload identity across Z module boundaries", () => {
  const directory = mkdtempSync("/tmp/z-mutex-modules-");
  const library = resolve(directory, "state.zs");
  const file = resolve(directory, "main.zs");
  try {
    writeFileSync(library, `
      import { Mutex } from "std/sync";

      export struct Counter {
        value: i32;
      }

      export function read(in state: Mutex<Counter>): i32 {
        return state.withLock(
          (in value): i32 => value.value
        );
      }
    `);
    writeFileSync(file, `
      import { Mutex } from "std/sync";
      import { Counter, read } from "./state.zs";

      function main(): i32 {
        const state = Mutex(Counter({ value: 42 }));
        return read(in state) - 42;
      }
    `);

    const result = spawnSync(process.execPath, [cli, "run", file], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("stores Mutex state inside an ARC application object", () => {
  const directory = mkdtempSync("/tmp/z-mutex-class-field-");
  const file = resolve(directory, "main.zs");
  try {
    const source = `
      import { Mutex } from "std/sync";

      struct State {
        revision: i32;
      }

      class Application {
        state: Mutex<State>;
      }

      function main(): i32 {
        const application = new Application({
          state: Mutex(State({ revision: 40 })),
        });
        application.state.withLock((inout value): void => {
          value.revision = value.revision + 2;
        });
        const revision = application.state.withLock(
          (in value): i32 => value.revision
        );
        return revision - 42;
      }
    `;
    writeFileSync(file, source);

    const result = spawnSync(process.execPath, [cli, "run", file], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("unlocks Mutex values while propagating typed closure errors", () => {
  const directory = mkdtempSync("/tmp/z-mutex-throw-unlock-");
  const file = resolve(directory, "main.zs");
  try {
    const source = `
      import { Mutex } from "std/sync";

      struct UpdateError {
        code: i32;
      }

      struct Counter {
        value: i32;
      }

      function fail(in counter: Mutex<Counter>): void throws UpdateError {
        try counter.withLock(
          (inout value): void throws UpdateError => {
            value.value = 42;
            throw UpdateError({ code: 7 });
          }
        );
      }

      function main(): i32 {
        const counter = Mutex(Counter({ value: 0 }));
        const outcome = attempt fail(in counter);
        const errorCode = match (outcome) {
          success => 0;
          failure(error) => error.code;
        };
        const value = counter.withLock(
          (in current): i32 => current.value
        );
        return errorCode - 7 + value - 42;
      }
    `;
    writeFileSync(file, source);

    const result = spawnSync(process.execPath, [cli, "run", file], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("destroys a Mutex payload exactly once with its owner", () => {
  const directory = mkdtempSync("/tmp/z-mutex-cleanup-");
  const file = resolve(directory, "main.zs");
  try {
    const source = `
      import console from "std/console";
      import { Mutex } from "std/sync";

      struct Resource {
        id: i32;

        deinit {
          console.log(\`released mutex resource \${this.id}\`);
        }
      }

      function main(): i32 {
        {
          const resource = Mutex(Resource({ id: 42 }));
          const observed = resource.withLock(
            (in value): i32 => value.id
          );
          if (observed != 42) return 1;
        }
        return 0;
      }
    `;
    writeFileSync(file, source);

    const result = spawnSync(process.execPath, [cli, "run", file], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "released mutex resource 42\n");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("moves Mutex ownership and rejects explicit duplication", () => {
  const directory = mkdtempSync("/tmp/z-mutex-move-");
  const file = resolve(directory, "main.zs");
  try {
    const source = `
      import { Mutex } from "std/sync";

      struct Counter {
        value: i32;
      }

      function main(): i32 {
        const first = Mutex(Counter({ value: 42 }));
        const second = move first;
        const observed = second.withLock(
          (in value): i32 => value.value
        );
        return observed - 42;
      }
    `;
    writeFileSync(file, source);

    const result = spawnSync(process.execPath, [cli, "run", file], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }

  const copied = diagnostics(`
    import { Mutex } from "std/sync";

    struct Counter {
      value: i32;
    }

    function main(): i32 {
      const first = Mutex(Counter({ value: 42 }));
      const second = copy first;
      return second.withLock((in value): i32 => value.value);
    }
  `, "/tmp/z-mutex-copy.zs")[0];
  assert.match(
    copied?.message ?? "",
    /cannot copy.*Mutex|Mutex.*cannot.*cop|Mutex.*move-only/i,
  );
});

test("rejects borrowed Mutex results and async lock closures", () => {
  const escapingView = `
    import { Mutex } from "std/sync";

    struct Item {
      id: i32;
      deinit {}
    }

    struct State {
      item: Item;
    }

    function main(): i32 {
      const state = Mutex(State({ item: Item({ id: 42 }) }));
      const escaped = state.withLock(
        (in value): view Item => value.item
      );
      return escaped.id;
    }
  `;
  const viewDiagnostic = diagnostics(
    escapingView,
    "/tmp/z-mutex-view-escape.zs",
  )[0];
  assert.match(
    viewDiagnostic?.message ?? "",
    /(?:view|borrowed).*cannot (?:escape|leave).*Mutex|Mutex\.withLock.*(?:view|borrowed).*non-escaping/i,
  );

  const asyncClosure = `
    import { Mutex } from "std/sync";

    struct State {
      value: i32;
    }

    async function main(): i32 {
      const state = Mutex(State({ value: 42 }));
      return await state.withLock(
        async (in value): i32 => value.value
      );
    }
  `;
  const asyncDiagnostic = diagnostics(
    asyncClosure,
    "/tmp/z-mutex-async-closure.zs",
  )[0];
  assert.match(
    asyncDiagnostic?.message ?? "",
    /Mutex\.withLock.*(?:synchronous|cannot suspend|does not accept an async closure)|async closure.*Mutex/i,
  );

});

test("shares one Mutex identity between the parent and native workers", () => {
  const directory = mkdtempSync("/tmp/z-mutex-thread-share-");
  const file = resolve(directory, "main.zs");
  try {
    const source = `
    import { Mutex } from "std/sync";
    import { thread } from "std/thread";

    struct State {
      value: i32;
    }

    async function main(): i32 {
      const state = Mutex(State({ value: 0 }));
      const first = thread.spawn(move (): void => {
        state.withLock((inout value): void => {
          value.value = value.value + 20;
        });
      });
      const second = thread.spawn(move (): void => {
        state.withLock((inout value): void => {
          value.value = value.value + 21;
        });
      });
      state.withLock((inout value): void => {
        value.value = value.value + 1;
      });
      await first;
      await second;
      return state.withLock(
        (in value): i32 => value.value
      ) - 42;
    }
    `;
    writeFileSync(file, source);

    const generated = compileToC(source, file);
    assert.match(generated, /z_mutex_State_retain\(frame->value_state\)/);
    assert.match(generated, /__atomic_add_fetch\(&mutex\.storage->refcount, 1, __ATOMIC_RELAXED\)/);
    assert.match(generated, /__atomic_sub_fetch\(&storage->refcount, 1, __ATOMIC_ACQ_REL\)/);
    assert.doesNotMatch(
      generated,
      /live_state\s*=\s*false,\s*z_mutex_State_retain/,
    );

    const result = spawnSync(process.execPath, [cli, "run", file], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);

    const native = spawnSync(
      process.execPath,
      [cli, "check", file, "--native-frontend"],
      { encoding: "utf8" },
    );
    assert.equal(native.status, 0, native.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);

test("shares readonly classes whose mutable state is entirely Mutex-protected", () => {
  const directory = mkdtempSync("/tmp/z-mutex-shareable-class-");
  const file = resolve(directory, "main.zs");
  try {
    const source = `
      import { Mutex } from "std/sync";
      import { thread } from "std/thread";

      struct State {
        value: i32;
      }

      class Holder {
        readonly state: Mutex<State>;

        function read(): i32 {
          return this.state.withLock((in value): i32 => value.value);
        }
      }

      async function main(): i32 {
        const holder = new Holder({ state: Mutex(State({ value: 42 })) });
        const worker = thread.spawn(move (): i32 => holder.read());
        return await worker - 42;
      }
    `;
    writeFileSync(file, source);

    assert.equal(diagnostics(source, file).length, 0);
    const result = spawnSync(process.execPath, [cli, "run", file], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects direct recursive acquisition of the same Mutex", () => {
  const source = `
    import { Mutex } from "std/sync";

    struct State { value: i32; }

    function main(): i32 {
      const state = Mutex(State({ value: 42 }));
      return state.withLock((in outer): i32 => {
        return state.withLock((in inner): i32 => inner.value + outer.value);
      });
    }
  `;
  const diagnostic = diagnostics(source, "/tmp/z-mutex-direct-reentrant.zs")[0];
  assert.equal(diagnostic?.code, "Z0211");
  assert.match(diagnostic?.message ?? "", /cannot recursively acquire "state"/);
  assert.match(diagnostic?.message ?? "", /non-reentrant/);
});

test("rejects a Mutex payload that cannot be destroyed on a worker", () => {
  const executorDiagnostic = diagnostics(`
    import { Mutex } from "std/sync";
    import { thread } from "std/thread";

    class WindowState on thread.main {
      value: i32;
    }

    async function main(): i32 on thread.main {
      const state = Mutex(new WindowState({ value: 42 }));
      const worker = thread.spawn(
        move (): i32 => state.withLock(
          (in value): i32 => value.value
        )
      );
      return await worker;
    }
  `, "/tmp/z-mutex-thread-affine-payload.zs")[0];
  assert.equal(executorDiagnostic?.code, "Z0711");
  assert.match(
    executorDiagnostic?.message ?? "",
    /WindowState.*requires thread\.main executor context/,
  );

  const cleanupDiagnostic = diagnostics(`
    import { Mutex } from "std/sync";
    import { thread } from "std/thread";

    struct Resource {
      value: i32;
      deinit {}
    }

    async function main(): i32 {
      const resource = Mutex(Resource({ value: 42 }));
      const worker = thread.spawn(
        move (): i32 => resource.withLock(
          (in value): i32 => value.value
        )
      );
      return await worker;
    }
  `, "/tmp/z-mutex-thread-cleanup-payload.zs")[0];
  assert.equal(cleanupDiagnostic?.code, "Z0704");
  assert.match(
    cleanupDiagnostic?.message ?? "",
    /Mutex payload Resource has a custom deinit/,
  );
});

test("shares mixed-affinity class identity while isolating selected members", () => {
  const directory = mkdtempSync("/tmp/z-mixed-affinity-mutex-");
  const file = resolve(directory, "main.zs");
  try {
    const source = `
      import { Mutex } from "std/sync";
      import { thread } from "std/thread";

      struct State {
        count: i32;
      }

      class Application {
        readonly name: String;
        readonly state: Mutex<State>;
        windowId: i32 on thread.main;

        function count(): i32 {
          return this.state.withLock(
            (in value): i32 => value.count
          );
        }

        function windowValue(): i32 on thread.main {
          return this.windowId;
        }
      }

      async function main(): i32 on thread.main {
        const app = new Application({
          name: "Z",
          state: Mutex(State({ count: 42 })),
          windowId: 7
        });
        const worker = thread.spawn(
          move (): i32 => app.count()
        );
        const observed = await worker;
        return observed - app.windowValue() - 35;
      }
    `;
    writeFileSync(file, source);

    const generated = compileToC(source, file);
    assert.match(generated, /Z_Application_count/);
    assert.match(generated, /z_mutex_State_retain/);
    const result = spawnSync(process.execPath, [cli, "run", file], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);

    const native = spawnSync(
      process.execPath,
      [cli, "check", file, "--native-frontend"],
      { encoding: "utf8" },
    );
    assert.equal(native.status, 0, native.stderr);

    const windowHover = hover(
      source,
      file,
      source.indexOf("windowId:") + 1,
    )?.contents.value ?? "";
    assert.match(windowHover, /windowId: i32 on thread\.main/);
    const windowUseHover = hover(
      source,
      file,
      source.indexOf("this.windowId") + "this.".length + 1,
    )?.contents.value ?? "";
    assert.match(windowUseHover, /executor-isolated to thread\.main/);

    const incompleteAffinity = source.replace(
      "windowId: i32 on thread.main;",
      "windowId: i32 on thread.ma;",
    );
    const affinityOffset = incompleteAffinity.indexOf("thread.ma")
      + "thread.ma".length;
    assert.equal(
      completions(incompleteAffinity, file, affinityOffset)
        .find((item) => item.label === "main")?.kind,
      10,
    );

    const unsafeMethod = source.replace(
      "return this.state.withLock(",
      "return this.windowId + this.state.withLock(",
    );
    const unsafeDiagnostic = diagnostics(unsafeMethod, file)[0];
    assert.equal(unsafeDiagnostic?.code, "Z0711");
    assert.match(unsafeDiagnostic?.message ?? "", /requires thread\.main executor context/);

    const escapedIdentity = source.replace(
      "move (): i32 => app.count()",
      "move (): i32 => { const alias = app; return alias.count(); }",
    );
    const escapeDiagnostic = diagnostics(escapedIdentity, file)[0];
    assert.equal(escapeDiagnostic?.code, "Z0704");
    assert.match(escapeDiagnostic?.message ?? "", /only opaque/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);

test("transports executor-bound ARC handles through value aggregates", () => {
  const directory = mkdtempSync("/tmp/z-executor-handle-aggregate-");
  const file = resolve(directory, "main.zs");
  try {
    const source = `
      import { Mutex, Once } from "std/sync";
      import { thread } from "std/thread";

      struct State {
        count: i32;
      }

      class Application {
        readonly state: Mutex<State>;
        windowId: i32 on thread.main;

        function count(): i32 {
          return this.state.withLock(
            (in value): i32 => value.count
          );
        }

        function windowValue(): i32 on thread.main {
          return this.windowId;
        }
      }

      struct WorkRequest {
        name: String;
        expected: i32;
      }

      struct WorkContext {
        application: Application;
        request: WorkRequest;
      }

      const applicationRoot = Once<Application>();

      function contextFor(
        in application: Application,
        expected: i32
      ): WorkContext {
        return WorkContext({
          application,
          request: WorkRequest({ name: "count", expected }),
        });
      }

      function expected(in request: WorkRequest): i32 {
        return request.expected;
      }

      function inspect(in context: WorkContext): i32 {
        return context.application.count() - expected(in context.request);
      }

      async function main(): i32 on thread.main {
        const application = new Application({
          state: Mutex(State({ count: 42 })),
          windowId: 7,
        });
        const lifetime = applicationRoot.initialize(move application);
        const worker = thread.spawn(move (): i32 => {
          const current = applicationRoot.get();
          const context = contextFor(current, 42);
          return inspect(in context);
        });
        return await worker;
      }
    `;
    writeFileSync(file, source);

    const generated = compileToC(source, file);
    assert.match(generated, /Z_WorkContext/);
    assert.match(generated, /Z_Application_retain/);
    assert.match(
      generated,
      /__z_function_adapter_inspect\(void \*_context, const Z_WorkContext \*context\)/,
    );

    const result = spawnSync(process.execPath, [cli, "run", file], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);

    const native = spawnSync(
      process.execPath,
      [cli, "check", file, "--native-frontend"],
      { encoding: "utf8" },
    );
    assert.equal(native.status, 0, native.stderr);

    const declarationHover = hover(
      source,
      file,
      source.indexOf("application: Application;") + 1,
    )?.contents.value ?? "";
    assert.match(declarationHover, /transportable ARC handle/);
    assert.match(declarationHover, /isolated Application members still require thread\.main/);

    const isolatedUse = source.replace(
      "context.application.count()",
      "context.application.windowValue()",
    );
    const isolatedDiagnostic = diagnostics(isolatedUse, file)[0];
    assert.equal(isolatedDiagnostic?.code, "Z0711");
    assert.match(
      isolatedDiagnostic?.message ?? "",
      /Application.*windowValue.*requires thread\.main executor context/,
    );

    const inlineAffinity = `
      import { thread } from "std/thread";

      struct MainValue {
        value: i32 on thread.main;
      }

      struct Envelope {
        value: MainValue;
      }

      function wrap(in value: MainValue): Envelope {
        return Envelope({ value });
      }
    `;
    const inlineDiagnostic = diagnostics(
      inlineAffinity,
      "/tmp/z-inline-executor-value.zs",
    )[0];
    assert.equal(inlineDiagnostic?.code, "Z0711");
    assert.match(
      inlineDiagnostic?.message ?? "",
      /Envelope.*requires thread\.main executor context/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 120_000);

test("retains Mutex identity in an ordinary owned closure environment", () => {
  const directory = mkdtempSync("/tmp/z-mutex-owned-closure-");
  const file = resolve(directory, "main.zs");
  try {
    const source = `
      import { Mutex } from "std/sync";

      struct State {
        value: i32;
      }

      type ReadState = () => i32;

      function main(): i32 {
        const state = Mutex(State({ value: 40 }));
        const read: ReadState = move (): i32 => state.withLock(
          (in value): i32 => value.value
        );
        state.withLock((inout value): void => {
          value.value = value.value + 2;
        });
        return read() - 42;
      }
    `;
    writeFileSync(file, source);

    const generated = compileToC(source, file);
    assert.match(generated, /z_mutex_State_retain\(/);

    const result = spawnSync(process.execPath, [cli, "run", file], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);

    const native = spawnSync(
      process.execPath,
      [cli, "check", file, "--native-frontend"],
      { encoding: "utf8" },
    );
    assert.equal(native.status, 0, native.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);

test("uses a synchronous Mutex critical section inside an async function", () => {
  const directory = mkdtempSync("/tmp/z-mutex-async-body-");
  const file = resolve(directory, "main.zs");
  try {
    const source = `
      import { Mutex } from "std/sync";

      struct State {
        value: i32;
      }

      async function inspect(in state: Mutex<State>): i32 {
        return state.withLock(
          (in value): i32 => value.value
        );
      }

      async function main(): i32 {
        const state = Mutex(State({ value: 42 }));
        return await inspect(in state) - 42;
      }
    `;
    writeFileSync(file, source);

    const result = spawnSync(process.execPath, [cli, "run", file], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("surfaces Mutex imports, inferred closure parameters, methods, and results in the editor", () => {
  const source = `
    import { Mutex } from "std/sync";

    struct Counter {
      value: i32;
    }

    function main(): i32 {
      const counter = Mutex(Counter({ value: 40 }));
      const observed = counter.withLock(
        (in value): i32 => value.value
      );
      counter.withLock((inout value): void => {
        value.value = value.value + 2;
      });
      return observed;
    }
  `;
  const file = "/tmp/z-mutex-editor.zs";

  assert.match(
    hover(source, file, source.indexOf("Mutex(Counter") + 1)
      ?.contents.value ?? "",
    /Mutex<T>.*synchronous.*lock/i,
  );
  assert.match(
    hover(source, file, source.indexOf("counter =") + 1)
      ?.contents.value ?? "",
    /counter: Mutex<Counter>/,
  );
  assert.match(
    hover(source, file, source.indexOf("withLock") + 1)
      ?.contents.value ?? "",
    /withLock.*(?:in|inout).*Counter/s,
  );
  assert.match(
    hover(source, file, source.indexOf("value): i32") + 1)
      ?.contents.value ?? "",
    /value: Counter/,
  );
  assert.match(
    hover(source, file, source.indexOf("observed =") + 1)
      ?.contents.value ?? "",
    /observed: i32/,
  );

  const memberSource = source.replace(
    "const observed = counter.withLock(",
    "const observed = counter.withL(",
  );
  const memberOffset = memberSource.indexOf("counter.withL")
    + "counter.withL".length;
  assert.match(
    completions(memberSource, file, memberOffset)
      .find((item) => item.label === "withLock")?.detail ?? "",
    /withLock/,
  );

  const importSource = `
    import { Mut } from "std/sync";
    function main(): i32 { return 0; }
  `;
  const importOffset = importSource.indexOf("Mut }") + 3;
  assert.equal(
    completions(importSource, file, importOffset)
      .find((item) => item.label === "Mutex")?.kind,
    22,
  );
});
