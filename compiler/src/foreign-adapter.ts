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
const foreignDeclarationProducerRevision = 4;

function adjacentContractSource(
  sourcePath: string,
  header: string,
  includeDirectories: readonly string[],
): string {
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
  return contractPath ? readFileSync(contractPath, "utf8") : "";
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
  );
  const contractSource = adjacentContractSource(
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
    .update(producerFingerprint)
    .update("\0")
    .update(contractSource)
    .digest("hex");
  const outputPath = resolve(outputArgument);
  const metadataPath = `${outputPath}.meta`;
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
  mkdirSync(dirname(outputPath), { recursive: true });
  writeAtomic(outputPath, stream);
  writeAtomic(metadataPath, `${cacheKey}\n`);
}
