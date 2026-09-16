import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { parse } from "./parser.ts";
import { lex } from "./lexer.ts";
import { prepareProject } from "./project.ts";
import {
  fingerprintForeignFunctionDeclarations,
  resolveForeignFunctionDeclarationStream,
} from "./foreign.ts";
import { foreignDeclarationProtocolVersion } from "./foreign-declaration-protocol.ts";

// Bump when producer semantics change without changing the ZFDCL wire shape.
// Cached declaration evidence must be regenerated even when an older artifact
// remains structurally decodable by the native frontend.
const foreignDeclarationProducerRevision = 6;

function adjacentContract(
  sourcePath: string,
  header: string,
  includeDirectories: readonly string[],
): { readonly path: string | null; readonly source: string } {
  const directories = [
    dirname(sourcePath),
    ...includeDirectories,
  ];
  const candidates = header.startsWith("/")
    ? [`${header}.zd`]
    : directories.flatMap((directory) => [
      resolve(directory, `${header}.zd`),
      resolve(directory, `${basename(header)}.zd`),
    ]);
  const contractPath = candidates.find(
    (candidate, index) => (
      candidates.indexOf(candidate) === index && existsSync(candidate)
    ),
  );
  return {
    path: contractPath ?? null,
    source: contractPath ? readFileSync(contractPath, "utf8") : "",
  };
}

function writeAtomic(path: string, contents: string): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, contents);
  renameSync(temporary, path);
}

export function writeForeignDeclarationArtifact(
  sourceArgument: string,
  header: string,
  outputArgument: string,
  projectArgument?: string,
): void {
  const sourcePath = resolve(sourceArgument);
  const source = readFileSync(sourcePath, "utf8");
  const program = parse(lex(source, sourcePath), sourcePath);
  const project = prepareProject(projectArgument ?? sourcePath);
  const declaration = program.imports.find((candidate) => candidate.header === header);
  if (!declaration) {
    throw new Error(
      `source does not import foreign header ${JSON.stringify(header)}`,
    );
  }
  const producerFingerprint = fingerprintForeignFunctionDeclarations(
    declaration,
    sourcePath,
    project.includeDirectories,
    project.deploymentTarget,
    `${resolve(outputArgument)}.deps.make`,
  );
  const contract = adjacentContract(
    sourcePath,
    header,
    project.includeDirectories,
  );
  const cacheKey = createHash("sha256")
    .update(
      `z-foreign-adapter-cache-v${foreignDeclarationProtocolVersion}`
      + `-r${foreignDeclarationProducerRevision}`,
    )
    .update("\0")
    .update(producerFingerprint.value)
    .update("\0")
    .update(contract.source)
    .digest("hex");
  const outputPath = resolve(outputArgument);
  const metadataPath = `${outputPath}.meta`;
  const dependencyPath = `${outputPath}.deps`;
  const dependencies = [
    ...producerFingerprint.dependencies,
    ...(contract.path ? [resolve(contract.path)] : []),
  ];
  const dependencySource = dependencies.length > 0
    ? `${dependencies.join("\0")}\0`
    : "";
  mkdirSync(dirname(outputPath), { recursive: true });
  writeAtomic(dependencyPath, dependencySource);
  const expectedProtocolPrefix =
    `ZFDCL${foreignDeclarationProtocolVersion.toString(16).padStart(16, "0")}\n`;
  if (
    existsSync(outputPath)
    && existsSync(metadataPath)
    && readFileSync(metadataPath, "utf8").trim() === cacheKey
    && readFileSync(outputPath, "utf8").startsWith(expectedProtocolPrefix)
  ) return;

  const stream = resolveForeignFunctionDeclarationStream(
    declaration,
    sourcePath,
    project.includeDirectories,
    project.deploymentTarget,
  );
  writeAtomic(outputPath, stream);
  writeAtomic(metadataPath, `${cacheKey}\n`);
}
