import type { Expression } from "./ast.ts";

export function identityBorrowsStorage(expression: Expression): boolean {
  return expression.kind === "identifier" || expression.kind === "argumentReference"
    || expression.kind === "member" || expression.kind === "index";
}

type Operand = {
  readonly value: string;
  readonly cType: string;
  readonly retain: string;
  readonly release: string;
  readonly borrowed: boolean;
  readonly plainBinding: boolean;
};

/** Keep evaluation and cleanup inside the expression, including short circuits. */
export function emitReferenceIdentity(operator: string, native: boolean, left: Operand, right: Operand): string {
  if (left.plainBinding && right.plainBinding) return `(${left.value} ${operator} ${right.value})`;
  const bind = (operand: Operand, name: string) => native
    ? `__attribute__((objc_precise_lifetime)) __strong id ${name} = ${operand.value};`
    : `${operand.cType} ${name} = ${operand.borrowed ? `${operand.retain}(${operand.value})` : operand.value};`;
  return `({ ${bind(left, "_z_identity_left")} ${bind(right, "_z_identity_right")} `
    + `bool _z_identity_result = (_z_identity_left ${operator} _z_identity_right); `
    + (native ? "" : `${right.release}(_z_identity_right); ${left.release}(_z_identity_left); `)
    + `_z_identity_result; })`;
}
