import fs from "std/fs";
import process from "std/process";
import { TextBuffer } from "std/text";
import {
  decodeRawForeignDeclarations,
} from "../frontend/foreign-declaration-protocol.zs";
import {
  normalizeForeignContracts,
  NativeForeignContractSet,
  parseForeignContracts,
  RawForeignContractSet,
  RawForeignFunctionContract,
  RawForeignTypeContract,
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

function adjacentForeignAdapter(in executablePath: String): String {
  const directory = directoryName(executablePath);
  const adjacent = normalizedModulePath(
    `${directory}/z-foreign-adapter`
  );
  if (fs.exists(adjacent)) return adjacent;
  const adjacentWindows = normalizedModulePath(
    `${directory}/z-foreign-adapter.exe`
  );
  if (fs.exists(adjacentWindows)) return adjacentWindows;
  return "z-foreign-adapter";
}

function foreignAdapterProgram(): String {
  return match (attempt process.executablePath()) {
    success(executablePath) => adjacentForeignAdapter(executablePath);
    failure(_) => "z-foreign-adapter";
  };
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

function resolvedForeignHeader(
  in modulePath: String,
  in header: String,
  in config: NativeProjectConfig
): String {
  if (isAbsolutePath(header)) return normalizedModulePath(header);
  const sourceDirectory = directoryName(modulePath);
  const sourceCandidate = normalizedModulePath(
    `${sourceDirectory}/${header}`
  );
  if (fs.exists(sourceCandidate)) return sourceCandidate;
  for (const includeDirectory of config.includeDirectories) {
    const candidate = normalizedModulePath(
      `${includeDirectory}/${header}`
    );
    if (fs.exists(candidate)) return candidate;
  }
  return sourceCandidate;
}

function resolvedDeclaredHeader(
  in contractPath: String,
  in moduleSpecifier: String
): String {
  if (isAbsolutePath(moduleSpecifier)) {
    return normalizedModulePath(moduleSpecifier);
  }
  const contractDirectory = directoryName(contractPath);
  return normalizedModulePath(`${contractDirectory}/${moduleSpecifier}`);
}

function inferredForeignContracts(in header: String): RawForeignContractSet {
  return RawForeignContractSet({
    moduleSpecifier: header.copyBytes(0, header.byteLength),
    lifetimes: Array<String>(),
    types: Array<RawForeignTypeContract>(),
    functions: Array<RawForeignFunctionContract>(),
  });
}

struct CacheHash {
  first: u8;
  second: u8;
  third: u8;
  fourth: u8;
  fifth: u8;
  sixth: u8;
  seventh: u8;
  eighth: u8;
  lane: usize;
}

function hashByte(inout hash: CacheHash, byte: u8): void {
  if (hash.lane == 0) {
    hash.first = hash.first ^ byte ^ hash.eighth;
  } else if (hash.lane == 1) {
    hash.second = hash.second ^ byte ^ hash.first;
  } else if (hash.lane == 2) {
    hash.third = hash.third ^ byte ^ hash.second;
  } else if (hash.lane == 3) {
    hash.fourth = hash.fourth ^ byte ^ hash.third;
  } else if (hash.lane == 4) {
    hash.fifth = hash.fifth ^ byte ^ hash.fourth;
  } else if (hash.lane == 5) {
    hash.sixth = hash.sixth ^ byte ^ hash.fifth;
  } else if (hash.lane == 6) {
    hash.seventh = hash.seventh ^ byte ^ hash.sixth;
  } else {
    hash.eighth = hash.eighth ^ byte ^ hash.seventh;
  }
  hash.lane = hash.lane + 1;
  if (hash.lane == 8) hash.lane = 0;
}

function hashText(inout hash: CacheHash, in value: String): void {
  let index: usize = 0;
  while (index < value.byteLength) {
    hashByte(inout hash, value.byteAt(index));
    index = index + 1;
  }
  hashByte(inout hash, 255);
}

function appendHexDigit(inout output: TextBuffer, value: u8): void {
  if (value < 10) {
    output.appendAscii(48 + value);
  } else {
    output.appendAscii(87 + value);
  }
}

function appendHexByte(inout output: TextBuffer, value: u8): void {
  appendHexDigit(inout output, value >> 4);
  appendHexDigit(inout output, value & 15);
}

function cacheIdentity(
  in modulePath: String,
  in header: String,
  in contractPath: String,
  in contractSource: String,
  in config: NativeProjectConfig
): String {
  let hash = CacheHash({
    first: 19,
    second: 47,
    third: 73,
    fourth: 101,
    fifth: 131,
    sixth: 157,
    seventh: 193,
    eighth: 229,
    lane: 0,
  });
  hashText(inout hash, "zfdcl-cache-v1");
  hashText(inout hash, modulePath);
  hashText(inout hash, header);
  hashText(inout hash, contractPath);
  hashText(inout hash, contractSource);
  hashText(inout hash, config.directory);
  for (const includeDirectory of config.includeDirectories) {
    hashText(inout hash, includeDirectory);
  }
  match (in config.platform) {
    some(platform) => hashText(inout hash, platform);
    none => hashText(inout hash, "host-default");
  }
  match (in config.minimumVersion) {
    some(version) => hashText(inout hash, version);
    none => hashText(inout hash, "");
  }
  let output = TextBuffer();
  appendHexByte(inout output, hash.first);
  appendHexByte(inout output, hash.second);
  appendHexByte(inout output, hash.third);
  appendHexByte(inout output, hash.fourth);
  appendHexByte(inout output, hash.fifth);
  appendHexByte(inout output, hash.sixth);
  appendHexByte(inout output, hash.seventh);
  appendHexByte(inout output, hash.eighth);
  return output.finish();
}

export function loadForeignModuleContract(
  in modulePath: String,
  in moduleSource: String,
  in moduleName: String,
  in header: String,
  line: usize,
  column: usize,
  in config: NativeProjectConfig,
  inout sharedContractKeys: Array<String>,
  inout sharedContracts: Array<NativeForeignContractSet>
): NativeForeignModuleContract throws String {
  let contractPath = "";
  let contractSource = "";
  let contracts = inferredForeignContracts(header);
  match (existingForeignContract(
    modulePath,
    header,
    config
  )) {
    some(path) => {
      contractPath = move path;
      contractSource = try fs.readText(contractPath);
      contracts = try parseForeignContracts(copy contractSource, contractPath);
    }
    none => {}
  }
  const identity = cacheIdentity(
    modulePath,
    header,
    contractPath,
    contractSource,
    config
  );
  const artifactPath = normalizedModulePath(
    `${config.directory}/.z-cache/foreign/${identity}.zfdcl`
  );
  let adapterArguments = Array<String>();
  adapterArguments.push(copy modulePath);
  adapterArguments.push(copy header);
  adapterArguments.push(copy artifactPath);
  match (in config.manifestPath) {
    some(path) => adapterArguments.push(copy path);
    none => {}
  }
  const adapterProgram = foreignAdapterProgram();
  const adapterOutcome = attempt process.run(
    adapterProgram,
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
  const producerCacheKey = try fs.readText(`${artifactPath}.meta`);
  const sharedContractKey = `${producerCacheKey}\n${moduleName}`;
  let sharedIndex: usize = 0;
  while (sharedIndex < sharedContractKeys.length) {
    if (sharedContractKeys[sharedIndex] == sharedContractKey) {
      return NativeForeignModuleContract({
        modulePath: modulePath.copyBytes(0, modulePath.byteLength),
        cacheKey: producerCacheKey,
        dependencyPath: `${artifactPath}.deps`,
        contracts: sharedContracts[sharedIndex],
      });
    }
    sharedIndex = sharedIndex + 1;
  }
  const declarationSource = try fs.readText(artifactPath);
  const declarations = try decodeRawForeignDeclarations(declarationSource);
  if (contractPath.byteLength > 0) {
    const declaredHeader = resolvedDeclaredHeader(
      contractPath,
      contracts.moduleSpecifier
    );
    const importedHeader = resolvedForeignHeader(modulePath, header, config);
    const exactSpecifier = contracts.moduleSpecifier == header;
    if (
      declaredHeader != importedHeader
      && (!exactSpecifier || fs.exists(declaredHeader))
    ) {
      throw sourceDiagnostic(
        contractPath,
        1,
        1,
        `Z declaration module "${contracts.moduleSpecifier}" does not match imported header "${header}"; resolved "${declaredHeader}" instead of "${importedHeader}"`,
        contractSource
      );
    }
    contracts.moduleSpecifier = header.copyBytes(0, header.byteLength);
  }
  const normalized = try normalizeForeignContracts(
    contracts,
    declarations,
    header
  );
  sharedContractKeys.push(move sharedContractKey);
  sharedContracts.push(normalized);
  return NativeForeignModuleContract({
    modulePath: modulePath.copyBytes(0, modulePath.byteLength),
    cacheKey: producerCacheKey,
    dependencyPath: `${artifactPath}.deps`,
    contracts: normalized,
  });
}
