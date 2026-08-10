import fs from "std/fs";
import { TextBuffer } from "std/text";
import {
  directoryName,
  normalizedModulePath,
} from "../frontend/module-paths.zs";

export struct NativeProjectConfig {
  manifestPath: Option<String>;
  directory: String;
  targetKind: String;
  targetName: Option<String>;
  runtimeInitializer: Option<String>;
  entry: Option<String>;
  platform: Option<String>;
  minimumVersion: Option<String>;
  includeDirectories: Array<String>;
  linkDirectories: Array<String>;
  linkLibraries: Array<String>;
  hasSwiftTarget: boolean;
}

struct JsonCursor {
  path: String;
  source: String;
  offset: usize;
}

function emptyProjectConfig(): NativeProjectConfig {
  return NativeProjectConfig({
    manifestPath: Option<String>.none,
    directory: "",
    targetKind: "executable",
    targetName: Option<String>.none,
    runtimeInitializer: Option<String>.none,
    entry: Option<String>.none,
    platform: Option<String>.none,
    minimumVersion: Option<String>.none,
    includeDirectories: Array<String>(),
    linkDirectories: Array<String>(),
    linkLibraries: Array<String>(),
    hasSwiftTarget: false,
  });
}

function jsonError(in cursor: JsonCursor, in message: String): String {
  let line: usize = 1;
  let column: usize = 1;
  let index: usize = 0;
  while (index < cursor.offset && index < cursor.source.byteLength) {
    if (cursor.source.byteAt(index) == 10) {
      line = line + 1;
      column = 1;
    } else {
      column = column + 1;
    }
    index = index + 1;
  }
  return `${cursor.path}:${line}:${column}: error: ${message}`;
}

function isWhitespace(byte: u8): boolean {
  return byte == 32 || byte == 9 || byte == 10 || byte == 13;
}

function skipWhitespace(inout cursor: JsonCursor): void {
  while (
    cursor.offset < cursor.source.byteLength
    && isWhitespace(cursor.source.byteAt(cursor.offset))
  ) {
    cursor.offset = cursor.offset + 1;
  }
}

function expectByte(
  inout cursor: JsonCursor,
  expected: u8,
  in description: String
): void throws String {
  skipWhitespace(inout cursor);
  if (
    cursor.offset >= cursor.source.byteLength
    || cursor.source.byteAt(cursor.offset) != expected
  ) {
    throw jsonError(cursor, `expected ${description}`);
  }
  cursor.offset = cursor.offset + 1;
}

function parseJsonString(inout cursor: JsonCursor): String throws String {
  skipWhitespace(inout cursor);
  if (
    cursor.offset >= cursor.source.byteLength
    || cursor.source.byteAt(cursor.offset) != 34
  ) {
    throw jsonError(cursor, "expected a JSON string");
  }
  cursor.offset = cursor.offset + 1;
  let output = TextBuffer();
  let chunkStart = cursor.offset;
  while (cursor.offset < cursor.source.byteLength) {
    const byte = cursor.source.byteAt(cursor.offset);
    if (byte == 34) {
      const chunkEnd = cursor.offset;
      output.appendBytes(cursor.source, chunkStart, chunkEnd);
      cursor.offset = cursor.offset + 1;
      return output.finish();
    }
    if (byte < 32) {
      throw jsonError(cursor, "JSON strings cannot contain control bytes");
    }
    if (byte != 92) {
      cursor.offset = cursor.offset + 1;
      continue;
    }

    const chunkEnd = cursor.offset;
    output.appendBytes(cursor.source, chunkStart, chunkEnd);
    cursor.offset = cursor.offset + 1;
    if (cursor.offset >= cursor.source.byteLength) {
      throw jsonError(cursor, "unterminated JSON string escape");
    }
    const escaped = cursor.source.byteAt(cursor.offset);
    if (escaped == 34 || escaped == 47 || escaped == 92) {
      output.appendAscii(escaped);
    } else if (escaped == 98) {
      output.appendAscii(8);
    } else if (escaped == 102) {
      output.appendAscii(12);
    } else if (escaped == 110) {
      output.appendAscii(10);
    } else if (escaped == 114) {
      output.appendAscii(13);
    } else if (escaped == 116) {
      output.appendAscii(9);
    } else if (escaped == 117) {
      throw jsonError(
        cursor,
        "escaped Unicode is not yet supported by the native z.json reader"
      );
    } else {
      throw jsonError(cursor, "invalid JSON string escape");
    }
    cursor.offset = cursor.offset + 1;
    chunkStart = cursor.offset;
  }
  throw jsonError(cursor, "unterminated JSON string");
}

function isNumberByte(byte: u8): boolean {
  return (
    (byte >= 48 && byte <= 57)
    || byte == 43
    || byte == 45
    || byte == 46
    || byte == 69
    || byte == 101
  );
}

function skipJsonValue(inout cursor: JsonCursor): void throws String {
  skipWhitespace(inout cursor);
  if (cursor.offset >= cursor.source.byteLength) {
    throw jsonError(cursor, "expected a JSON value");
  }
  const first = cursor.source.byteAt(cursor.offset);
  if (first == 34) {
    const ignored = try parseJsonString(inout cursor);
    return;
  }
  if (first == 123) {
    cursor.offset = cursor.offset + 1;
    skipWhitespace(inout cursor);
    if (
      cursor.offset < cursor.source.byteLength
      && cursor.source.byteAt(cursor.offset) == 125
    ) {
      cursor.offset = cursor.offset + 1;
      return;
    }
    while (true) {
      const key = try parseJsonString(inout cursor);
      try expectByte(inout cursor, 58, "\":\"");
      try skipJsonValue(inout cursor);
      skipWhitespace(inout cursor);
      if (
        cursor.offset < cursor.source.byteLength
        && cursor.source.byteAt(cursor.offset) == 44
      ) {
        cursor.offset = cursor.offset + 1;
        continue;
      }
      try expectByte(inout cursor, 125, "\"}\"");
      return;
    }
  }
  if (first == 91) {
    cursor.offset = cursor.offset + 1;
    skipWhitespace(inout cursor);
    if (
      cursor.offset < cursor.source.byteLength
      && cursor.source.byteAt(cursor.offset) == 93
    ) {
      cursor.offset = cursor.offset + 1;
      return;
    }
    while (true) {
      try skipJsonValue(inout cursor);
      skipWhitespace(inout cursor);
      if (
        cursor.offset < cursor.source.byteLength
        && cursor.source.byteAt(cursor.offset) == 44
      ) {
        cursor.offset = cursor.offset + 1;
        continue;
      }
      try expectByte(inout cursor, 93, "\"]\"");
      return;
    }
  }

  const start = cursor.offset;
  while (
    cursor.offset < cursor.source.byteLength
    && (
      isNumberByte(cursor.source.byteAt(cursor.offset))
      || (
        cursor.source.byteAt(cursor.offset) >= 65
        && cursor.source.byteAt(cursor.offset) <= 90
      )
      || (
        cursor.source.byteAt(cursor.offset) >= 97
        && cursor.source.byteAt(cursor.offset) <= 122
      )
    )
  ) {
    cursor.offset = cursor.offset + 1;
  }
  if (cursor.offset == start) throw jsonError(cursor, "expected a JSON value");
  const literal = cursor.source.copyBytes(start, cursor.offset);
  if (
    literal != "true"
    && literal != "false"
    && literal != "null"
    && !isNumberByte(literal.byteAt(0))
  ) {
    throw jsonError(cursor, "invalid JSON literal");
  }
}

function parseStringArray(
  inout cursor: JsonCursor,
  in field: String
): Array<String> throws String {
  try expectByte(inout cursor, 91, "a JSON string array");
  let values = Array<String>();
  skipWhitespace(inout cursor);
  if (
    cursor.offset < cursor.source.byteLength
    && cursor.source.byteAt(cursor.offset) == 93
  ) {
    cursor.offset = cursor.offset + 1;
    return values;
  }
  while (true) {
    const value = try parseJsonString(inout cursor);
    if (value.byteLength == 0) {
      throw jsonError(cursor, `z.json ${field} cannot contain an empty string`);
    }
    values.push(value);
    skipWhitespace(inout cursor);
    if (
      cursor.offset < cursor.source.byteLength
      && cursor.source.byteAt(cursor.offset) == 44
    ) {
      cursor.offset = cursor.offset + 1;
      continue;
    }
    try expectByte(inout cursor, 93, "\"]\"");
    return values;
  }
  throw jsonError(cursor, "unterminated JSON string array");
}

function parseLink(
  inout cursor: JsonCursor,
  inout config: NativeProjectConfig
): void throws String {
  try expectByte(inout cursor, 123, "an object for target.link");
  skipWhitespace(inout cursor);
  if (
    cursor.offset < cursor.source.byteLength
    && cursor.source.byteAt(cursor.offset) == 125
  ) {
    cursor.offset = cursor.offset + 1;
    return;
  }
  while (true) {
    const key = try parseJsonString(inout cursor);
    try expectByte(inout cursor, 58, "\":\"");
    if (key == "directories") {
      config.linkDirectories = try parseStringArray(
        inout cursor,
        "target.link.directories"
      );
    } else if (key == "libraries") {
      config.linkLibraries = try parseStringArray(
        inout cursor,
        "target.link.libraries"
      );
    } else {
      throw jsonError(
        cursor,
        `z.json target.link contains unknown field "${key}"`
      );
    }
    skipWhitespace(inout cursor);
    if (
      cursor.offset < cursor.source.byteLength
      && cursor.source.byteAt(cursor.offset) == 44
    ) {
      cursor.offset = cursor.offset + 1;
      continue;
    }
    try expectByte(inout cursor, 125, "\"}\"");
    return;
  }
}

function parseRuntime(
  inout cursor: JsonCursor,
  inout config: NativeProjectConfig
): void throws String {
  try expectByte(inout cursor, 123, "an object for target.runtime");
  let foundInitialize = false;
  skipWhitespace(inout cursor);
  if (
    cursor.offset < cursor.source.byteLength
    && cursor.source.byteAt(cursor.offset) == 125
  ) {
    throw jsonError(cursor, "z.json target.runtime requires initialize");
  }
  while (true) {
    const key = try parseJsonString(inout cursor);
    try expectByte(inout cursor, 58, "\":\"");
    if (key == "initialize") {
      if (foundInitialize) {
        throw jsonError(cursor, "z.json target.runtime repeats initialize");
      }
      foundInitialize = true;
      const initializer = try parseJsonString(inout cursor);
      config.runtimeInitializer = Option.some(initializer);
    } else {
      throw jsonError(
        cursor,
        `z.json target.runtime contains unknown field "${key}"`
      );
    }
    skipWhitespace(inout cursor);
    if (
      cursor.offset < cursor.source.byteLength
      && cursor.source.byteAt(cursor.offset) == 44
    ) {
      cursor.offset = cursor.offset + 1;
      continue;
    }
    try expectByte(inout cursor, 125, "\"}\"");
    if (!foundInitialize) {
      throw jsonError(cursor, "z.json target.runtime requires initialize");
    }
    return;
  }
}

function parseTarget(
  inout cursor: JsonCursor,
  inout config: NativeProjectConfig
): void throws String {
  try expectByte(inout cursor, 123, "an object for target");
  skipWhitespace(inout cursor);
  if (
    cursor.offset < cursor.source.byteLength
    && cursor.source.byteAt(cursor.offset) == 125
  ) {
    cursor.offset = cursor.offset + 1;
    return;
  }
  while (true) {
    const key = try parseJsonString(inout cursor);
    try expectByte(inout cursor, 58, "\":\"");
    if (key == "kind") {
      config.targetKind = try parseJsonString(inout cursor);
    } else if (key == "name") {
      const name = try parseJsonString(inout cursor);
      config.targetName = Option.some(name);
    } else if (key == "entry") {
      const entry = try parseJsonString(inout cursor);
      config.entry = Option.some(entry);
    } else if (key == "platform") {
      const platform = try parseJsonString(inout cursor);
      config.platform = Option.some(platform);
    } else if (key == "minimumVersion") {
      const minimumVersion = try parseJsonString(inout cursor);
      config.minimumVersion = Option.some(minimumVersion);
    } else if (key == "includeDirectories") {
      config.includeDirectories = try parseStringArray(
        inout cursor,
        "target.includeDirectories"
      );
    } else if (key == "runtime") {
      try parseRuntime(inout cursor, inout config);
    } else if (key == "link") {
      try parseLink(inout cursor, inout config);
    } else if (key == "swift") {
      config.hasSwiftTarget = true;
      try skipJsonValue(inout cursor);
    } else {
      throw jsonError(
        cursor,
        `z.json target contains unknown field "${key}"`
      );
    }
    skipWhitespace(inout cursor);
    if (
      cursor.offset < cursor.source.byteLength
      && cursor.source.byteAt(cursor.offset) == 44
    ) {
      cursor.offset = cursor.offset + 1;
      continue;
    }
    try expectByte(inout cursor, 125, "\"}\"");
    return;
  }
}

function parseProjectManifest(
  in path: String,
  in directory: String,
  source: String
): NativeProjectConfig throws String {
  let cursor = JsonCursor({
    path: copy path,
    source,
    offset: 0,
  });
  let config = emptyProjectConfig();
  config.manifestPath = Option.some(copy path);
  config.directory = copy directory;
  try expectByte(inout cursor, 123, "a JSON object");
  skipWhitespace(inout cursor);
  if (
    cursor.offset < cursor.source.byteLength
    && cursor.source.byteAt(cursor.offset) == 125
  ) {
    cursor.offset = cursor.offset + 1;
  } else {
    while (true) {
      const key = try parseJsonString(inout cursor);
      try expectByte(inout cursor, 58, "\":\"");
      if (key == "target") {
        try parseTarget(inout cursor, inout config);
      } else {
        throw jsonError(
          cursor,
          `z.json root contains unknown field "${key}"`
        );
      }
      skipWhitespace(inout cursor);
      if (
        cursor.offset < cursor.source.byteLength
        && cursor.source.byteAt(cursor.offset) == 44
      ) {
        cursor.offset = cursor.offset + 1;
        continue;
      }
      try expectByte(inout cursor, 125, "\"}\"");
      break;
    }
  }
  skipWhitespace(inout cursor);
  if (cursor.offset != cursor.source.byteLength) {
    throw jsonError(cursor, "unexpected text after the project manifest");
  }
  return config;
}

function isAbsolutePath(in path: String): boolean {
  if (path.byteLength > 0 && (path.byteAt(0) == 47 || path.byteAt(0) == 92)) {
    return true;
  }
  return (
    path.byteLength > 2
    && path.byteAt(1) == 58
    && (path.byteAt(2) == 47 || path.byteAt(2) == 92)
  );
}

function configuredPath(
  in directory: String,
  in path: String
): String {
  if (isAbsolutePath(path)) return normalizedModulePath(path);
  return normalizedModulePath(`${directory}/${path}`);
}

function containsString(
  in values: Array<String>,
  in candidate: String
): boolean {
  for (const value of values) {
    if (value == candidate) return true;
  }
  return false;
}

function resolveDirectories(
  in values: Array<String>,
  in directory: String,
  in manifestPath: String,
  in field: String
): Array<String> throws String {
  let resolved = Array<String>();
  for (const value of values) {
    const candidate = configuredPath(directory, value);
    if (!fs.exists(candidate)) {
      throw `${manifestPath}:1:1: error: z.json ${field} directory "${candidate}" does not exist`;
    }
    if (!fs.isDirectory(candidate)) {
      throw `${manifestPath}:1:1: error: z.json ${field} path "${candidate}" is not a directory`;
    }
    const canonical = try fs.realPath(candidate);
    if (!containsString(resolved, canonical)) resolved.push(canonical);
  }
  return resolved;
}

function validLibraryName(in name: String): boolean {
  if (name.byteLength == 0) return false;
  let index: usize = 0;
  while (index < name.byteLength) {
    const byte = name.byteAt(index);
    const valid = (
      (byte >= 48 && byte <= 57)
      || (byte >= 65 && byte <= 90)
      || (byte >= 97 && byte <= 122)
      || byte == 43
      || byte == 45
      || byte == 46
      || byte == 95
    );
    if (!valid) return false;
    index = index + 1;
  }
  const first = name.byteAt(0);
  return (
    (first >= 48 && first <= 57)
    || (first >= 65 && first <= 90)
    || (first >= 97 && first <= 122)
  );
}

function validZIdentifier(in name: String): boolean {
  if (name.byteLength == 0) return false;
  const first = name.byteAt(0);
  if (
    !(
      (first >= 65 && first <= 90)
      || (first >= 97 && first <= 122)
      || first == 95
    )
  ) return false;
  let index: usize = 1;
  while (index < name.byteLength) {
    const byte = name.byteAt(index);
    if (
      !(
        (byte >= 48 && byte <= 57)
        || (byte >= 65 && byte <= 90)
        || (byte >= 97 && byte <= 122)
        || byte == 95
      )
    ) return false;
    index = index + 1;
  }
  return true;
}

function hasZSourceExtension(in path: String): boolean {
  return (
    path.byteLength >= 3
    && path.byteAt(path.byteLength - 3) == 46
    && path.byteAt(path.byteLength - 2) == 122
    && path.byteAt(path.byteLength - 1) == 115
  );
}

function normalizedPlatform(in platform: String): String {
  if (platform == "macos" || platform == "macosx" || platform == "darwin") {
    return "macos";
  }
  if (platform == "win32" || platform == "windows") return "windows";
  return copy platform;
}

function validVersion(in version: String): boolean {
  if (version.byteLength == 0) return false;
  let componentStart = true;
  let index: usize = 0;
  let components: usize = 1;
  while (index < version.byteLength) {
    const byte = version.byteAt(index);
    if (byte == 46) {
      if (componentStart || components == 4) return false;
      componentStart = true;
      components = components + 1;
    } else {
      if (byte < 48 || byte > 57) return false;
      componentStart = false;
    }
    index = index + 1;
  }
  return !componentStart;
}

function validateProjectConfig(
  inout config: NativeProjectConfig
): void throws String {
  let manifestPath = "";
  match (in config.manifestPath) {
    some(path) => manifestPath = copy path;
    none => return;
  }
  config.includeDirectories = try resolveDirectories(
    config.includeDirectories,
    config.directory,
    manifestPath,
    "target.includeDirectories"
  );
  config.linkDirectories = try resolveDirectories(
    config.linkDirectories,
    config.directory,
    manifestPath,
    "target.link.directories"
  );
  let libraries = Array<String>();
  for (const library of config.linkLibraries) {
    if (!validLibraryName(library)) {
      throw `${manifestPath}:1:1: error: z.json target.link.libraries must contain native library names such as "sqlite3"`;
    }
    if (!containsString(libraries, library)) libraries.push(copy library);
  }
  config.linkLibraries = move libraries;
  if (
    config.targetKind != "executable"
    && config.targetKind != "static-library"
    && config.targetKind != "shared-library"
  ) {
    throw `${manifestPath}:1:1: error: z.json target.kind must be "executable", "static-library", or "shared-library"`;
  }
  match (in config.targetName) {
    some(name) => {
      if (!validLibraryName(name)) {
        throw `${manifestPath}:1:1: error: z.json target.name must be a portable native artifact name`;
      }
    }
    none => {
      throw `${manifestPath}:1:1: error: z.json ${config.targetKind} target requires target.name`;
    }
  }
  match (in config.runtimeInitializer) {
    some(initializer) => {
      if (config.targetKind == "executable") {
        throw `${manifestPath}:1:1: error: z.json target.runtime.initialize is only valid for static-library and shared-library targets`;
      }
      if (!validZIdentifier(initializer)) {
        throw `${manifestPath}:1:1: error: z.json target.runtime.initialize must name a Z function in the target entry module`;
      }
    }
    none => {}
  }
  if (config.hasSwiftTarget) {
    throw `${manifestPath}:1:1: error: Swift target preparation remains in the Stage-0 project driver`;
  }
  match (in config.entry) {
    some(entry) => {
      if (!hasZSourceExtension(entry)) {
        throw `${manifestPath}:1:1: error: z.json target.entry must be a Z source path`;
      }
      const entryPath = configuredPath(config.directory, entry);
      if (!fs.exists(entryPath)) {
        throw `${manifestPath}:1:1: error: Z entry "${entryPath}" does not exist`;
      }
    }
    none => {}
  }
  match (in config.entry) {
    some(_) => {}
    none => throw `${manifestPath}:1:1: error: z.json ${config.targetKind} target requires target.entry`;
  }

  let platform = "";
  let minimumVersion = "";
  match (in config.platform) {
    some(value) => platform = normalizedPlatform(value);
    none => {}
  }
  match (in config.minimumVersion) {
    some(value) => minimumVersion = copy value;
    none => {}
  }
  if (
    (platform.byteLength == 0 && minimumVersion.byteLength > 0)
    || (platform.byteLength > 0 && minimumVersion.byteLength == 0)
  ) {
    throw `${manifestPath}:1:1: error: z.json target.platform and target.minimumVersion must be specified together`;
  }
  if (minimumVersion.byteLength > 0 && !validVersion(minimumVersion)) {
    throw `${manifestPath}:1:1: error: z.json target.minimumVersion must be a numeric version such as "13.0"`;
  }
  if (platform.byteLength > 0) {
    config.platform = Option.some(platform);
  }
}

export function configuredProjectEntryPath(
  in config: NativeProjectConfig
): String throws String {
  let manifestPath = "";
  match (in config.manifestPath) {
    some(path) => manifestPath = copy path;
    none => throw "project mode requires a z.json manifest";
  }
  const entry = match (in config.entry) {
    some(entry) => entry.copyBytes(0, entry.byteLength);
    none => throw `${manifestPath}:1:1: error: z.json ${config.targetKind} target requires target.entry`;
  };
  return configuredPath(config.directory, entry);
}

export function loadProjectConfig(
  in entryPath: String
): NativeProjectConfig throws String {
  const entryDirectory = directoryName(entryPath);
  let directory = copy entryDirectory;
  while (true) {
    const candidate = normalizedModulePath(`${directory}/z.json`);
    if (fs.exists(candidate)) {
      const canonical = try fs.realPath(candidate);
      const source = try fs.readText(canonical);
      let config = try parseProjectManifest(canonical, directory, source);
      try validateProjectConfig(inout config);
      return config;
    }
    const parent = directoryName(directory);
    if (parent == directory) {
      let config = emptyProjectConfig();
      config.directory = copy entryDirectory;
      return config;
    }
    directory = move parent;
  }
  throw "project manifest search did not terminate";
}

export function appendProjectCompileArguments(
  in config: NativeProjectConfig,
  inout arguments: Array<String>
): void throws String {
  arguments.push("-I");
  arguments.push(copy config.directory);
  for (const directory of config.includeDirectories) {
    if (directory == config.directory) continue;
    arguments.push("-I");
    arguments.push(copy directory);
  }
  match (in config.platform) {
    some(platform) => {
      if (platform != "macos") {
        throw `native deployment target flags are not implemented for ${platform}`;
      }
      match (in config.minimumVersion) {
        some(version) => arguments.push(`-mmacosx-version-min=${version}`);
        none => {}
      }
    }
    none => {}
  }
}

export function appendProjectCompilerArguments(
  in config: NativeProjectConfig,
  inout arguments: Array<String>
): void throws String {
  try appendProjectCompileArguments(config, inout arguments);
  for (const directory of config.linkDirectories) {
    arguments.push(`-L${directory}`);
  }
  for (const library of config.linkLibraries) {
    arguments.push(`-l${library}`);
  }
}
