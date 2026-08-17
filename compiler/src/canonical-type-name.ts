import { parseDynamicArrayType, parseFixedArrayType, parseSliceType } from "./array-types.ts";
import { displayTaskType, parseTaskType } from "./async-types.ts";
import { parseFunctionType } from "./function-types.ts";
import { parseGenericType } from "./generic-types.ts";
import { isNullableObjCTypeName, publicObjCTypeName } from "./objc-types.ts";
import { parseViewType } from "./view-types.ts";
import { parseReadonlyType } from "./readonly-types.ts";

export function canonicalTypeName(name: string): string {
  const readonly = parseReadonlyType(name);
  if (readonly) return `readonly ${canonicalTypeName(readonly.target)}`;
  const task = parseTaskType(name);
  if (task) return displayTaskType(task, canonicalTypeName);
  if (isNullableObjCTypeName(name)) return `${canonicalTypeName(publicObjCTypeName(name))} | null`;
  const view = parseViewType(name);
  if (view) return `view ${canonicalTypeName(view.target)}`;
  const fixed = parseFixedArrayType(name);
  if (fixed) return `${canonicalTypeName(fixed.elementType)}[${fixed.length}]`;
  const slice = parseSliceType(name);
  if (slice) return `Slice<${canonicalTypeName(slice.elementType)}>`;
  const dynamic = parseDynamicArrayType(name);
  if (dynamic) return `${dynamic.readonly ? "readonly " : ""}Array<${canonicalTypeName(dynamic.elementType)}>`;
  const generic = parseGenericType(name);
  if (generic) return `${generic.base}<${generic.arguments.map(canonicalTypeName).join(", ")}>`;
  const functionType = parseFunctionType(name);
  if (functionType) {
    const parameters = functionType.parameters.map((parameter) => {
      const capability = parameter.mode === "value" ? "" : `${parameter.mode} `;
      return `${capability}${parameter.name}: ${canonicalTypeName(parameter.type)}`;
    });
    const throws = functionType.errorType ? ` throws ${canonicalTypeName(functionType.errorType)}` : "";
    const thread = functionType.thread === "any" ? " on thread.any" : "";
    return `(${parameters.join(", ")}) => ${canonicalTypeName(functionType.returnType)}${throws}${thread}`;
  }
  return name;
}
