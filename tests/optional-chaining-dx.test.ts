import {
  assert,
  projectRoot,
  readFileSync,
  resolve,
  test,
} from "./support/bootstrap.ts";

test("the TextMate grammar distinguishes optional chaining from optional fields", () => {
  const grammar = JSON.parse(readFileSync(
    resolve(projectRoot, "editors/vscode/syntaxes/z.tmLanguage.json"),
    "utf8",
  ));
  const optionalChain = grammar.repository.operators.patterns.find(
    (pattern: { name?: string }) => pattern.name === "keyword.operator.optional-chaining.z",
  );
  assert.ok(optionalChain);

  const pattern = new RegExp(optionalChain.match);
  assert.match("session?.displayName", pattern);
  assert.match("session?.refresh()", pattern);
  assert.doesNotMatch("session?: Session", pattern);
});
