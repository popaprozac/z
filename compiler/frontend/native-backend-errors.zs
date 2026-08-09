export function internalBackendFailure(
  in phase: String,
  in detail: String
): String {
  return `internal compiler error: ${phase}: ${detail}`;
}
