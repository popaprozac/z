import {
  assert,
  cli,
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
