/** Quote source text for C-family output, protecting it from translation-phase trigraphs. */
export function cStringLiteral(value: string): string {
  // C11 processes trigraphs even inside literals, before parsing string escapes.
  // JSON quoting alone is therefore insufficient for embedded JS such as `??=`.
  return JSON.stringify(value).replaceAll("?", "\\?");
}
