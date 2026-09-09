import { ParsedModule } from "./module-symbols.zs";
import {
  ModuleObjCAvailabilitySignature, ModuleResolveError, ModuleResolveErrorKind,
  ResolvedModule, codedModuleResolutionError,
} from "./semantic-model.zs";
import { rebaseTypeName, typeSymbolLocation } from "./semantic-type-identities.zs";

function platformName(in name: String): String {
  if (name == "darwin" || name == "macosx") return "macos";
  if (name == "win32") return "windows";
  return copy name;
}

function componentEnd(in version: String, start: usize): usize {
  let end = start;
  while (end < version.byteLength && version.byteAt(end) != 46) { end = end + 1; }
  return end;
}

// Compare numeric dotted versions without integer overflow or floating-point
// conversion. Missing trailing components and leading zeroes compare equally.
export function compareNativeVersions(in left: String, in right: String): i32 {
  let leftStart: usize = 0;
  let rightStart: usize = 0;
  while (leftStart < left.byteLength || rightStart < right.byteLength) {
    const leftEnd = componentEnd(left, leftStart);
    const rightEnd = componentEnd(right, rightStart);
    while (leftStart < leftEnd && left.byteAt(leftStart) == 48) { leftStart = leftStart + 1; }
    while (rightStart < rightEnd && right.byteAt(rightStart) == 48) { rightStart = rightStart + 1; }
    const leftLength = leftEnd - leftStart;
    const rightLength = rightEnd - rightStart;
    if (leftLength < rightLength) return -1;
    if (leftLength > rightLength) return 1;
    let index: usize = 0;
    while (index < leftLength) {
      if (left.byteAt(leftStart + index) < right.byteAt(rightStart + index)) return -1;
      if (left.byteAt(leftStart + index) > right.byteAt(rightStart + index)) return 1;
      index = index + 1;
    }
    leftStart = leftEnd;
    rightStart = rightEnd;
    if (leftStart < left.byteLength) leftStart = leftStart + 1;
    if (rightStart < right.byteLength) rightStart = rightStart + 1;
  }
  return 0;
}

export function requireNativeAvailability(
  in module: ParsedModule, in facts: Array<ModuleObjCAvailabilitySignature>,
  in name: String, line: usize, column: usize
): void throws ModuleResolveError {
  if (facts.length == 0) return;
  const target = platformName(module.targetPlatform);
  for (const fact of facts) {
    const platform = platformName(fact.platform);
    if (platform.byteLength > 0 && target.byteLength == 0) {
      throw codedModuleResolutionError(ModuleResolveErrorKind.unsupportedLowering, "Z0814", module.path,
        "native availability checking requires target platform evidence", line, column, 1);
    }
    if (platform.byteLength > 0 && platform != target) continue;
    let reason = "";
    if (fact.unavailable) {
      reason = `foreign declaration "${name}" is unavailable`;
      if (platform.byteLength > 0) reason = `${reason} on ${platform}`;
    } else if (module.targetMinimumVersion.byteLength > 0) {
      if (fact.introduced.byteLength > 0
        && compareNativeVersions(module.targetMinimumVersion, fact.introduced) < 0) {
        reason = `foreign declaration "${name}" requires ${target} ${fact.introduced}, but the deployment target is ${target} ${module.targetMinimumVersion}`;
      } else if (fact.obsoleted.byteLength > 0
        && compareNativeVersions(module.targetMinimumVersion, fact.obsoleted) >= 0) {
        reason = `foreign declaration "${name}" was obsoleted in ${target} ${fact.obsoleted}; the deployment target is ${module.targetMinimumVersion}`;
      }
    }
    if (reason.byteLength > 0) {
      if (fact.message.byteLength > 0) reason = `${reason}; ${fact.message}`;
      throw codedModuleResolutionError(ModuleResolveErrorKind.typeMismatch, "Z0802", module.path,
        reason, line, column, 1);
    }
  }
  // Deprecations are retained metadata, not hard errors. Warning reporting is
  // a separate native diagnostic-parity slice.
}

export function requireNativeReferenceAvailability(
  in module: ParsedModule, in modules: Array<ResolvedModule>, moduleIndex: usize,
  in typeName: String, line: usize, column: usize
): void throws ModuleResolveError {
  let current = copy typeName;
  let seen = Array<String>();
  while (current.byteLength > 0) {
    const location = match (typeSymbolLocation(modules, moduleIndex, current)) {
      some(value) => value;
      none => return;
    };
    const identity = `${location.moduleIndex}:${location.symbolIndex}`;
    for (const prior of seen) { if (prior == identity) return; }
    seen.push(identity);
    match (in modules[location.moduleIndex].symbols[location.symbolIndex].typeSignature) {
      some(signature) => {
        try requireNativeAvailability(module, signature.foreignObjCAvailability, current, line, column);
        current = rebaseTypeName(modules, location.moduleIndex, moduleIndex, signature.foreignObjCSuperName);
      }
      none => return;
    }
  }
}
