import { TextBuffer } from "std/text";

function isSlash(byte: u8): boolean {
  return byte == 47 || byte == 92;
}

export function isLocalModuleHeader(in header: String): boolean {
  const relative = header.byteLength >= 2
    && header.byteAt(0) == 46
    && (
      isSlash(header.byteAt(1))
      || (
        header.byteLength >= 3
        && header.byteAt(1) == 46
        && isSlash(header.byteAt(2))
      )
    );
  if (!relative || header.byteLength < 3) return false;
  return header.byteAt(header.byteLength - 3) == 46
    && header.byteAt(header.byteLength - 2) == 122
    && header.byteAt(header.byteLength - 1) == 115;
}

export function isStandardModuleHeader(in header: String): boolean {
  if (header == "std") return true;
  return (
    header.byteLength > 4
    && header.byteAt(0) == 115
    && header.byteAt(1) == 116
    && header.byteAt(2) == 100
    && isSlash(header.byteAt(3))
  );
}

export function sourceStandardModuleRelativePath(
  in header: String
): Option<String> {
  if (!isStandardModuleHeader(header) || header == "std") {
    return Option<String>.none;
  }
  let index: usize = 4;
  let segmentLength: usize = 0;
  while (index < header.byteLength) {
    const byte = header.byteAt(index);
    if (isSlash(byte)) {
      if (segmentLength == 0) return Option<String>.none;
      segmentLength = 0;
    } else {
      const alphaNumeric = (
        (byte >= 48 && byte <= 57)
        || (byte >= 65 && byte <= 90)
        || (byte >= 97 && byte <= 122)
      );
      if (!alphaNumeric && byte != 45 && byte != 95) {
        return Option<String>.none;
      }
      segmentLength = segmentLength + 1;
    }
    index = index + 1;
  }
  if (segmentLength == 0) return Option<String>.none;
  const relative = header.copyBytes(4, header.byteLength);
  return Option.some(`${relative}.zs`);
}

export function sourceStandardModulePathMatches(
  in path: String,
  in header: String
): boolean {
  const relative = match (sourceStandardModuleRelativePath(header)) {
    some(relative) => relative;
    none => return false;
  };
  const suffix = `stdlib/${relative}`;
  if (path.byteLength < suffix.byteLength) return false;
  const start = path.byteLength - suffix.byteLength;
  if (start > 0 && !isSlash(path.byteAt(start - 1))) return false;
  let index: usize = 0;
  while (index < suffix.byteLength) {
    const expected = suffix.byteAt(index);
    const actual = path.byteAt(start + index);
    if (expected == 47) {
      if (!isSlash(actual)) return false;
    } else if (actual != expected) return false;
    index = index + 1;
  }
  return true;
}

export function directoryName(in path: String): String {
  let index = path.byteLength;
  while (index > 0) {
    index = index - 1;
    if (!isSlash(path.byteAt(index))) continue;
    if (index == 0) return "/";
    return path.copyBytes(0, index);
  }
  return ".";
}

function storeSegment(
  inout segments: Array<String>,
  count: usize,
  segment: String
): void {
  if (count < segments.length) segments[count] = segment;
  else segments.push(segment);
}

export function normalizedModulePath(in path: String): String {
  let segments = Array<String>();
  let count: usize = 0;
  const absolute = path.byteLength > 0 && isSlash(path.byteAt(0));
  let start: usize = 0;
  let current: usize = 0;
  while (current <= path.byteLength) {
    const boundary = current == path.byteLength || isSlash(path.byteAt(current));
    if (!boundary) {
      current = current + 1;
      continue;
    }
    if (current > start) {
      const segment = path.copyBytes(start, current);
      if (segment == ".") {
      } else if (segment == "..") {
        let floor: usize = 0;
        if (
          count > 0
          && segments[0].byteLength == 2
          && segments[0].byteAt(1) == 58
        ) floor = 1;
        if (count > floor) count = count - 1;
        else if (!absolute) {
          storeSegment(inout segments, count, segment);
          count = count + 1;
        }
      } else {
        storeSegment(inout segments, count, segment);
        count = count + 1;
      }
    }
    start = current + 1;
    current = current + 1;
  }

  let output = TextBuffer();
  if (absolute) output.append("/");
  let index: usize = 0;
  while (index < count) {
    if (index > 0) output.append("/");
    output.append(segments[index]);
    index = index + 1;
  }
  return output.finish();
}

export function importedModulePath(in importer: String, in header: String): String {
  const directory = directoryName(importer);
  return normalizedModulePath(`${directory}/${header}`);
}
