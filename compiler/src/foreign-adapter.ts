import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
const foreignDeclarationProducerRevision = 8;

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

function readSharedArtifact(path: string, key: string, prefix: string): string | null {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!value || typeof value !== "object") return null;
    const cached = value as Record<string, unknown>;
    if (
      cached.key !== key
      || typeof cached.stream !== "string"
      || !cached.stream.startsWith(prefix)
      || cached.digest !== createHash("sha256").update(cached.stream).digest("hex")
    ) return null;
    return cached.stream;
  } catch {
    // Missing, interrupted, or corrupt cache entries are misses, not evidence.
    return null;
  }
}

function producerDependencies(): string[] {
  // The driver can reuse an executable before invoking this adapter. Record
  // the producer itself so replacing the helper invalidates that outer cache.
  // A packaged adapter is its executable; a source-run adapter additionally
  // depends on the entry script and the compiler's TypeScript implementation.
  const paths = [process.execPath];
  const sourceDirectory = dirname(fileURLToPath(import.meta.url));
  if (existsSync(resolve(sourceDirectory, "foreign-adapter.ts"))) {
    const entry = process.argv[1];
    if (entry && existsSync(entry)) paths.push(resolve(entry));
    for (const entry of readdirSync(sourceDirectory, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".ts")) {
        paths.push(resolve(sourceDirectory, entry.name));
      }
    }
  }
  // Standalone Bun's argv[1] names an embedded virtual file, not an OS input.
  // Its bytes are already covered by the executable recorded above.
  return [...new Set(paths)];
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
  const outputPath = resolve(outputArgument);
  mkdirSync(dirname(outputPath), { recursive: true });
  const producerFingerprint = fingerprintForeignFunctionDeclarations(
    declaration,
    sourcePath,
    project.includeDirectories,
    project.deploymentTarget,
    `${outputPath}.${process.pid}.deps.make`,
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
    // ZFDCL contains qualified type names; never share between import aliases.
    .update(declaration.moduleName)
    .update("\0")
    .update(contract.path ?? "")
    .update("\0")
    .update(contract.source)
    .digest("hex");
  const metadataPath = `${outputPath}.meta`;
  const dependencyPath = `${outputPath}.deps`;
  const dependencies = [
    ...producerFingerprint.dependencies,
    ...(contract.path ? [resolve(contract.path)] : []),
    ...producerDependencies(),
  ];
  const dependencySource = dependencies.length > 0
    ? `${dependencies.join("\0")}\0`
    : "";
  writeAtomic(dependencyPath, dependencySource);
  const expectedProtocolPrefix =
    `ZFDCL${foreignDeclarationProtocolVersion.toString(16).padStart(16, "0")}\n`;
  if (
    existsSync(outputPath)
    && existsSync(metadataPath)
    && readFileSync(metadataPath, "utf8").trim() === cacheKey
    && readFileSync(outputPath, "utf8").startsWith(expectedProtocolPrefix)
  ) return;

  // Native imports have per-module output paths. Share the expensive producer
  // work only after validating identical headers, include order, target,
  // toolchain macros, namespace, and all sidecar/API-note contents. Keep the
  // module's own artifact/dependency files for normal native-driver validation.
  const sharedPath = resolve(dirname(outputPath), "shared", `${cacheKey}.json`);
  const shared = readSharedArtifact(sharedPath, cacheKey, expectedProtocolPrefix);
  const stream = shared ?? resolveForeignFunctionDeclarationStream(
    declaration,
    sourcePath,
    project.includeDirectories,
    project.deploymentTarget,
    // Also invalidate the in-process header cache when this API is called
    // repeatedly and only a transitive header (not the root header) changed.
    producerFingerprint.value,
  );
  if (shared === null) {
    mkdirSync(dirname(sharedPath), { recursive: true });
    writeAtomic(sharedPath, JSON.stringify({
      key: cacheKey,
      digest: createHash("sha256").update(stream).digest("hex"),
      stream,
    }));
  }
  writeAtomic(outputPath, stream);
  writeAtomic(metadataPath, `${cacheKey}\n`);
}
