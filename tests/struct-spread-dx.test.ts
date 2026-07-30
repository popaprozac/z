import {
  assert,
  decodeSemanticTokens,
  hover,
  positionForOffset,
  projectRoot,
  readFileSync,
  resolve,
  semanticTokens,
  semanticTokenTypes,
  test,
} from "./support/bootstrap.ts";

test("the TextMate grammar distinguishes struct spread and its ownership capability", () => {
  const grammar = JSON.parse(readFileSync(
    resolve(projectRoot, "editors/vscode/syntaxes/z.tmLanguage.json"),
    "utf8",
  ));
  const spread = grammar.repository.operators.patterns.find(
    (pattern: { name?: string }) => pattern.name === "keyword.operator.spread.z",
  );
  assert.ok(spread);
  const spreadPattern = new RegExp(spread.match);
  assert.match("...source", spreadPattern);
  assert.match("copy ...source", spreadPattern);
  assert.match("move ...source", spreadPattern);
  assert.doesNotMatch("source.member", spreadPattern);

  const ownership = grammar.repository.keywords.patterns.find(
    (pattern: { name?: string }) => pattern.name === "keyword.operator.ownership.z",
  );
  assert.ok(ownership);
  const ownershipPattern = new RegExp(ownership.match);
  assert.match("copy ...source", ownershipPattern);
  assert.match("move ...source", ownershipPattern);
});

test("semantic tokens keep spread capabilities and source bindings readable", () => {
  const source = `
    struct RequestOptions {
      endpoint: String;
      timeoutMilliseconds: i32 = 1000;
    }

    function main(): i32 {
      const original = RequestOptions({ endpoint: "/notes" });
      const snapshot = RequestOptions({
        copy ...original,
        timeoutMilliseconds: 2500,
      });
      const installed = RequestOptions({
        move ...snapshot,
        endpoint: "/notes/active",
      });
      return installed.timeoutMilliseconds - 2500;
    }
  `;
  const tokens = decodeSemanticTokens(
    semanticTokens(source, "struct-spread-editor.zs").data,
  );
  for (const keyword of ["copy", "move"]) {
    const offset = source.indexOf(keyword);
    const position = positionForOffset(source, offset);
    assert.ok(tokens.some((token) => (
      token.line === position.line
      && token.character === position.character
      && semanticTokenTypes[token.type] === "keyword"
    )), `${keyword} should be a semantic keyword`);
  }

  const originalUse = source.indexOf("original", source.indexOf("copy ..."));
  const snapshotUse = source.indexOf("snapshot", source.indexOf("move ..."));
  assert.match(
    hover(source, "struct-spread-editor.zs", originalUse + 1)?.contents.value ?? "",
    /original: RequestOptions/,
  );
  assert.match(
    hover(source, "struct-spread-editor.zs", snapshotUse + 1)?.contents.value ?? "",
    /snapshot: RequestOptions/,
  );
});
