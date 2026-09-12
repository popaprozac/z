import {
  assert,
  cli,
  compileToC,
  completions,
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

test("parses and stringifies recursive JSON values from std/json", () => {
  const fixture = resolve(projectRoot, "tests/fixtures/std-json-smoke.zs");
  const result = spawnSync(process.execPath, [cli, "run", fixture], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
});

test("preserves nominal JSON numbers losslessly and converts them explicitly", () => {
  const fixture = resolve(projectRoot, "tests/fixtures/std-json-number.zs");
  const result = spawnSync(process.execPath, [cli, "run", fixture], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
});

test("derives exact typed JSON codecs for ordinary value structs", () => {
  const fixture = resolve(projectRoot, "tests/fixtures/std-json-typed.zs");
  const result = spawnSync(process.execPath, [cli, "run", fixture], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
});

test("escapes native keyword fields without changing JSON keys or colliding with user names", () => {
  const fixture = resolve(projectRoot, "tests/fixtures/self-host-emit-field-hygiene.zs");
  const result = spawnSync(process.execPath, [cli, "run", fixture], {
    encoding: "utf8", timeout: 60000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '{"signed":-42,"unsigned":42,"z_signed":8,"z_field_signed":6,"template":"kept"}\n');
});

test("derives streaming JSON decoders for nested and recursive value structs", () => {
  const fixture = resolve(projectRoot, "tests/fixtures/std-json-recursive.zs");
  const result = spawnSync(process.execPath, [cli, "run", fixture], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
});

test("round-trips nested readonly structs and recursive readonly arrays with derived JSON", () => {
  const fixture = resolve(projectRoot, "tests/fixtures/std-json-nested-encode.zs");
  const result = spawnSync(process.execPath, [cli, "run", fixture], {
    encoding: "utf8",
    timeout: 60000,
  });
  assert.equal(result.status, 0, result.stderr);
});

test("rejects unsupported derived JSON field types at the codec request", () => {
  const fileName = resolve(projectRoot, "tests/fixtures/std-json-unsupported.zs");
  assert.throws(
    () => compileToC(`
      import json from "std/json";

      struct Measurement {
        value: f32;
      }

      function main(): i32 {
        const value = attempt json.decode<Measurement>("{\\\"value\\\":1.5}");
        return 0;
      }
    `, fileName),
    /field "value" has unsupported type "f32"/,
  );
  assert.throws(
    () => compileToC(`
      import json from "std/json";

      struct PartialUser {
        name?: String;
      }

      function main(): i32 {
        const value = attempt json.decode<PartialUser>("{}");
        return 0;
      }
    `, fileName),
    /optional field "name" is not supported yet/,
  );
});

test("decodes finite f64 JSON fields without truncating fractions", () => {
  const fixture = resolve(projectRoot, "tests/fixtures/std-json-f64-decode.zs");
  const result = spawnSync(process.execPath, [cli, "run", fixture], { encoding: "utf8", timeout: 60000 });
  assert.equal(result.status, 0, result.stderr);
});

test("derives Option fields with explicit nulls, required presence, and defaults", () => {
  const fixture = resolve(projectRoot, "tests/fixtures/std-json-option.zs");
  const result = spawnSync(process.execPath, [cli, "run", fixture], {
    encoding: "utf8",
    timeout: 60000,
  });
  assert.equal(result.status, 0, result.stderr);
});

test("rejects ambiguous nested Options and unsupported Option payload codecs", () => {
  for (const [type, message] of [
    ["Option<Option<String>>", /JSON null cannot distinguish none from some\(none\)/],
    ["Option<f64>", /unsupported type/],
    ["Array<Option<String>>", /unsupported type/],
  ] as const) {
    const source = `
      import json from "std/json";
      struct Value { value: ${type}; }
      function encode(in value: Value): String { return json.encode(in value); }
      function main(): i32 { return 0; }
    `;
    assert.throws(() => compileToC(source, "unsupported-option-json.zs"), message);
  }
});

test("reports JSON syntax failures with source positions", () => {
  const directory = mkdtempSync("/tmp/z-stdlib-json-errors-");
  const input = resolve(directory, "main.zs");
  writeFileSync(input, `
    import json from "std/json";

    function main(): i32 {
      const result = attempt json.parse("{\\n\\\"x\\\":]");
      return match (result) {
        success(_) => 1;
        failure(error) => {
          if (error.message != "expected a JSON value") return 2;
          if (error.offset != 6) return 3;
          if (error.line != 2) return 4;
          if (error.column != 5) return 5;
          select 0;
        }
      };
    }
  `);
  const result = spawnSync(process.execPath, [cli, "run", input], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  rmSync(directory, { recursive: true, force: true });
});

test("offers source-backed std/json namespace completion and hover", () => {
  const fileName = resolve(projectRoot, "tests/fixtures/std-json-editor.zs");
  const source = `
    import json from "std/json";
    function main(): i32 {
      const value = attempt json.parse("null");
      const encoded = json.str;
      return 0;
    }
  `;
  const completionOffset = source.indexOf("json.str") + "json.str".length;
  const stringify = completions(source, fileName, completionOffset)
    .find((item) => item.label === "stringify");
  assert.ok(stringify, JSON.stringify(completions(source, fileName, completionOffset)));
  assert.match(stringify.detail ?? "", /stringify\(in value: JsonValue\): String/);

  const decode = completions(source.replace("json.str", "json.dec"), fileName, completionOffset)
    .find((item) => item.label === "decode");
  assert.ok(decode);
  assert.match(decode.detail ?? "", /decode<T>\(in source: String\): T throws JsonError/);

  const hoverSource = source.replace(
    "const encoded = json.str;",
    "const encoded = \"\";",
  );
  const hoverOffset = hoverSource.indexOf("json.parse") + "json.".length + 2;
  assert.match(
    hover(hoverSource, fileName, hoverOffset)?.contents.value ?? "",
    /parse\(in source: String\): JsonValue throws JsonError/,
  );

  assert.match(readFileSync(resolve(projectRoot, "stdlib/json.zs"), "utf8"), /export enum JsonValue/);
});
