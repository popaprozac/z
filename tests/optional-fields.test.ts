import {
  analyzeSource,
  assert,
  cli,
  compileToC,
  completions,
  decodeSemanticTokens,
  hover,
  mkdtempSync,
  positionForOffset,
  resolve,
  rmSync,
  semanticTokens,
  semanticTokenTypes,
  spawnSync,
  test,
  writeFileSync,
} from "./support/bootstrap.ts";

test("explains optional fields through hover, completion, and semantic tokens", () => {
  const source = `
    struct Image {
      id: i32;
    }
    struct WindowOptions {
      icon?: Image;
    }
    function main(): i32 {
      const options = WindowOptions({ icon: Image({ id: 1 }) });
      const observed = options.icon;
      return 0;
    }
  `;
  const declarationOffset = source.indexOf("icon?:");
  assert.match(
    hover(source, "optional-editor.zs", declarationOffset + 1)?.contents.value ?? "",
    /icon\?: Image\s+\/\/ stored as Option<Image>; omission initializes Option\.none/,
  );
  const literalOffset = source.indexOf("icon:", source.indexOf("WindowOptions({"));
  assert.match(
    hover(source, "optional-editor.zs", literalOffset + 1)?.contents.value ?? "",
    /icon\?: Image\s+\/\/ accepts Image or Option<Image>; omission initializes Option\.none/,
  );
  const memberOffset = source.indexOf("icon;", source.indexOf("options."));
  assert.match(
    hover(source, "optional-editor.zs", memberOffset + 1)?.contents.value ?? "",
    /icon: Option<Image>\s+\/\/ optional presence; match some\/none/,
  );

  const completionSource = source.replace(
    "icon: Image({ id: 1 })",
    "ico",
  );
  const completionOffset = completionSource.indexOf("ico });") + 3;
  assert.match(
    completions(completionSource, "optional-editor.zs", completionOffset)
      .find((item) => item.label === "icon")?.detail ?? "",
    /icon\?: Image \(optional\/defaulted; accepts Image or Option<Image>; omitted → none\)/,
  );

  const questionOffset = source.indexOf("?");
  const questionPosition = positionForOffset(source, questionOffset);
  const tokens = decodeSemanticTokens(semanticTokens(source, "optional-editor.zs").data);
  assert.ok(tokens.some((token) => (
    token.line === questionPosition.line
    && token.character === questionPosition.character
    && semanticTokenTypes[token.type] === "keyword"
  )));
});

test("stores optional fields as Option and contextually lifts direct payloads", () => {
  const source = `
    struct Envelope<T> {
      payload?: T;
    }

    function observe(in envelope: Envelope<i32>): i32 {
      return match (in envelope.payload) {
        some(value) => value;
        none => 0;
      };
    }

    function main(): i32 {
      const omitted = Envelope<i32>();
      const lifted = Envelope({ payload: 20 });
      const option: Option<i32> = Option.some(22);
      const explicit = Envelope({ payload: option });
      const explicitNone = Envelope<i32>({ payload: Option.none });
      return observe(in omitted) + observe(in lifted) + observe(in explicit) + observe(in explicitNone) - 42;
    }
  `;
  const directory = mkdtempSync("/tmp/z-optional-fields-");
  const fileName = resolve(directory, "main.zs");
  writeFileSync(fileName, source);
  const result = spawnSync(process.execPath, [cli, "run", fileName], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);

  const analyzed = analyzeSource(source, fileName);
  const envelope = analyzed.program.structs.find((declaration) => (
    analyzed.semanticInfo.typeDisplayNames.get(declaration.name)?.startsWith("Envelope<")
  ));
  assert.equal(envelope?.fields[0].optional, true);
  assert.match(analyzed.semanticInfo.typeDisplayNames.get(envelope?.fields[0].type.name ?? "") ?? "", /^Option<i32>$/);
  rmSync(directory, { recursive: true, force: true });
});

test("moves cleanup-bearing payloads into optional fields", () => {
  const source = `
    struct Resource {
      id: i32;
      deinit {}
    }

    struct Holder {
      resource?: Resource;
    }

    function main(): i32 {
      const resource = Resource({ id: 42 });
      const holder = Holder({ resource: move resource });
      const observed = match (in holder.resource) {
        some(value) => value.id;
        none => 0;
      };
      return observed - 42;
    }
  `;
  const generated = compileToC(source, "optional-owned.zs");
  assert.match(generated, /Z_Resource/);
  assert.match(generated, /some/);
  const directory = mkdtempSync("/tmp/z-optional-owned-");
  const fileName = resolve(directory, "main.zs");
  writeFileSync(fileName, source);
  const result = spawnSync(process.execPath, [cli, "run", fileName], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  rmSync(directory, { recursive: true, force: true });
});

test("lifts cleanup-bearing construction temporaries into optional fields", () => {
  const source = `
    import console from "std/console";

    struct Resource {
      id: i32;
      label: String;

      deinit {
        console.log(\`released \${this.id}\`);
      }
    }

    struct Holder {
      resource?: Resource;
    }

    function main(): i32 {
      const holder = Holder({
        resource: Resource({
          id: 42,
          label: \`resource-\${42}\`,
        }),
      });
      const observed = match (in holder.resource) {
        some(value) => value.id;
        none => 0;
      };
      return observed - 42;
    }
  `;
  const generated = compileToC(source, "optional-direct-owned.zs");
  assert.match(
    generated,
    /_z_aggregate_\d+ = \(Z_Option_Resource\)\{ \.tag = Z_Option_Resource_some, \.data = \{ \.some = _z_argument_\d+ \} \};/,
  );
  assert.match(generated, /\.resource = _z_aggregate_\d+/);
  const directory = mkdtempSync("/tmp/z-optional-direct-owned-");
  const fileName = resolve(directory, "main.zs");
  writeFileSync(fileName, source);
  const result = spawnSync(process.execPath, [cli, "run", fileName], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "released 42\n");
  rmSync(directory, { recursive: true, force: true });
});

test("preserves optional presence and direct lifting across source modules", () => {
  const directory = mkdtempSync("/tmp/z-optional-field-modules-");
  const model = resolve(directory, "model.zs");
  const main = resolve(directory, "main.zs");
  writeFileSync(model, `
    export struct Resource {
      id: i32;
      deinit {}
    }

    export struct Selection {
      resource?: Resource;
    }
  `);
  writeFileSync(main, `
    import { Resource, Selection } from "./model.zs";

    function main(): i32 {
      const empty = Selection();
      const resource = Resource({ id: 42 });
      const selected = Selection({ resource: move resource });
      const missing = match (in empty.resource) {
        some(value) => value.id;
        none => 0;
      };
      const observed = match (in selected.resource) {
        some(value) => value.id;
        none => 0;
      };
      return missing + observed - 42;
    }
  `);

  const execution = spawnSync(process.execPath, [cli, "run", main], { encoding: "utf8" });
  assert.equal(execution.status, 0, execution.stderr);
  const parity = spawnSync(
    process.execPath,
    [cli, "check", main, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(parity.status, 0, parity.stderr);
  rmSync(directory, { recursive: true, force: true });
});

test("keeps explicit Option fields required and rejects optional defaults", () => {
  assert.throws(
    () => compileToC(`
      struct Ambiguous {
        count?: i32 = 1;
      }
      function main(): i32 { return 0; }
    `, "optional-default.zs"),
    /optional field "count" already defaults to Option\.none/,
  );

  assert.throws(
    () => compileToC(`
      struct RequiredOption {
        count: Option<i32>;
      }
      function main(): i32 {
        const value = RequiredOption();
        return 0;
      }
    `, "required-option.zs"),
    /missing field "count" when constructing "RequiredOption"/,
  );

  assert.throws(
    () => compileToC(`
      class Session {
        token?: String;
      }
      function main(): i32 { return 0; }
    `, "optional-class-field.zs"),
    /optional stored fields are currently supported only on value structs/,
  );
});
