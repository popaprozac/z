// Lexer tokens retain source spelling. AST numeric values are separator-free,
// decimal spellings so semantic checks and C emission cannot reinterpret a radix
// digit as an exponent or a leading zero as C octal.
export function normalizeNumericLiteral(spelling: string): string {
  const value = spelling.replaceAll("_", "");
  if (/^0[xXbB]/.test(value)) return BigInt(value).toString();
  if (/[.eE]/.test(value)) return value;
  return value.replace(/^0+(?=[0-9])/, "");
}
