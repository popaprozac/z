import type { Expression, Program } from "./ast.ts";
import { DiagnosticError } from "./diagnostics.ts";
import { parseMapType } from "./map-types.ts";
import { parseSetType } from "./set-types.ts";

/**
 * Expands synthesized value-struct initialization before semantic analysis.
 *
 * Field defaults remain ordinary Z expressions. Every construction receives its
 * own evaluation of each omitted default, while explicit initializers suppress
 * the corresponding default entirely.
 */
export function materializeStructDefaults(program: Program, fileName: string): Program {
  const aggregates = new Map(program.structs.map((declaration) => [declaration.name, declaration]));

  const transform = (value: any, expanding: ReadonlySet<string> = new Set()): any => {
    if (Array.isArray(value)) return value.map((item) => transform(item, expanding));
    if (!value || typeof value !== "object") return value;

    if (value.kind === "call" && value.callee?.kind === "identifier") {
      const call = {
        ...value,
        callee: transform(value.callee, expanding),
        arguments: value.arguments.map((argument: Expression) => transform(argument, expanding)),
      };
      const declaration = aggregates.get(call.callee.name);
      if (
        !declaration
        || declaration.kind !== "struct"
        || declaration.constructor
        || parseMapType(declaration.name)
        || parseSetType(declaration.name)
      ) return call;
      if (
        call.arguments.length > 1
        || (call.arguments.length === 1 && call.arguments[0].kind !== "objectExpression")
      ) {
        return call;
      }

      const object = call.arguments[0] ?? {
        kind: "objectExpression",
        fields: [],
        location: call.location,
      };
      const provided = new Set(object.fields.map((field: { readonly name: string }) => field.name));
      const defaults = declaration.fields
        .filter((field) => !provided.has(field.name) && field.defaultValue)
        .map((field) => {
          if (expanding.has(declaration.name)) {
            throw new DiagnosticError(
              fileName,
              field.defaultValue!.location,
              `default value for ${JSON.stringify(declaration.name)}.${field.name} recursively constructs ${JSON.stringify(declaration.name)}`,
            );
          }
          return {
            name: field.name,
            expression: transform(field.defaultValue, new Set([...expanding, declaration.name])),
            location: field.location,
          };
        });
      return {
        ...call,
        arguments: [{ ...object, fields: [...object.fields, ...defaults] }],
        argumentLabels: [null],
      };
    }

    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, transform(child, expanding)]),
    );
  };

  return transform(program) as Program;
}
