import fs from "std/fs";
import process from "std/process";
import {
  decodeRawForeignDeclarations,
} from "../frontend/foreign-declaration-protocol.zs";
import {
  normalizeForeignContracts,
  parseForeignContracts,
} from "../frontend/foreign-contracts.zs";
import {
  directoryName,
  normalizedModulePath,
} from "../frontend/module-paths.zs";
import {
  NativeForeignModuleContract,
} from "../frontend/semantic-foreign.zs";
import {
  sourceDiagnostic,
} from "./diagnostics.zs";
import {
  NativeProjectConfig,
} from "./project-manifest.zs";

function isPathSlash(byte: u8): boolean {
  return byte == 47 || byte == 92;
}

function isAbsolutePath(in path: String): boolean {
  if (path.byteLength > 0 && isPathSlash(path.byteAt(0))) return true;
  return (
    path.byteLength >= 3
    && (
      (path.byteAt(0) >= 65 && path.byteAt(0) <= 90)
      || (path.byteAt(0) >= 97 && path.byteAt(0) <= 122)
    )
    && path.byteAt(1) == 58
    && isPathSlash(path.byteAt(2))
  );
}

function baseName(in path: String): String {
  let index = path.byteLength;
  while (index > 0) {
    index = index - 1;
    if (isPathSlash(path.byteAt(index))) {
      return path.copyBytes(index + 1, path.byteLength);
    }
  }
  return copy path;
}

function existingForeignContract(
  in modulePath: String,
  in header: String,
  in config: NativeProjectConfig
): Option<String> {
  let candidates = Array<String>();
  if (isAbsolutePath(header)) {
    candidates.push(`${header}.zd`);
  } else {
    const sourceDirectory = directoryName(modulePath);
    candidates.push(
      normalizedModulePath(`${sourceDirectory}/${header}.zd`)
    );
    const flatName = baseName(header);
    candidates.push(
      normalizedModulePath(`${sourceDirectory}/${flatName}.zd`)
    );
    for (const includeDirectory of config.includeDirectories) {
      candidates.push(
        normalizedModulePath(`${includeDirectory}/${header}.zd`)
      );
      candidates.push(
        normalizedModulePath(`${includeDirectory}/${flatName}.zd`)
      );
    }
  }
  for (const candidate of candidates) {
    if (fs.exists(candidate)) return Option.some(copy candidate);
  }
  return Option<String>.none;
}

export function loadForeignModuleContract(
  in modulePath: String,
  in moduleSource: String,
  in header: String,
  line: usize,
  column: usize,
  in config: NativeProjectConfig
): NativeForeignModuleContract throws String {
  const contractPath = match (existingForeignContract(
    modulePath,
    header,
    config
  )) {
    some(path) => path;
    none => throw sourceDiagnostic(
      modulePath,
      line,
      column,
      `native foreign import "${header}" requires an adjacent .zd contract`,
      moduleSource
    );
  };
  const artifactPath = `${contractPath}.zfdcl`;
  let adapterArguments = Array<String>();
  adapterArguments.push(copy modulePath);
  adapterArguments.push(copy header);
  adapterArguments.push(copy artifactPath);
  const adapterOutcome = attempt process.run(
    "z-foreign-adapter",
    adapterArguments
  );
  const adapterStatus = match (adapterOutcome) {
    success(status) => status;
    failure(message) => throw sourceDiagnostic(
      modulePath,
      line,
      column,
      `could not launch z-foreign-adapter for "${header}": ${message}`,
      moduleSource
    );
  };
  if (adapterStatus != 0) {
    throw sourceDiagnostic(
      modulePath,
      line,
      column,
      `foreign adapter failed for "${header}" with exit code ${adapterStatus}`,
      moduleSource
    );
  }
  const declarationSource = try fs.readText(artifactPath);
  const declarations = try decodeRawForeignDeclarations(declarationSource);
  const contractSource = try fs.readText(contractPath);
  const contracts = try parseForeignContracts(contractSource, contractPath);
  const normalized = try normalizeForeignContracts(
    contracts,
    declarations,
    header
  );
  return NativeForeignModuleContract({
    modulePath: modulePath.copyBytes(0, modulePath.byteLength),
    contracts: normalized,
  });
}
