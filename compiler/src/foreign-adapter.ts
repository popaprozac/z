import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "./parser.ts";
import { lex } from "./lexer.ts";
import { prepareProject } from "./project.ts";
import { resolveForeignFunctionDeclarationStream } from "./foreign.ts";

export function writeForeignDeclarationArtifact(
  sourceArgument: string,
  header: string,
  outputArgument: string,
): void {
  const sourcePath = resolve(sourceArgument);
  const source = readFileSync(sourcePath, "utf8");
  const program = parse(lex(source, sourcePath), sourcePath);
  const project = prepareProject(sourcePath);
  const declaration = program.imports.find((candidate) => candidate.header === header);
  if (!declaration) {
    throw new Error(
      `source does not import foreign header ${JSON.stringify(header)}`,
    );
  }
  const stream = resolveForeignFunctionDeclarationStream(
    declaration,
    sourcePath,
    project.includeDirectories,
    project.deploymentTarget,
  );
  writeFileSync(resolve(outputArgument), stream);
}
