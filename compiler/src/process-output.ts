import { spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type SpilledProcessResult = {
  readonly status: number | null;
  readonly error: Error | undefined;
  readonly stderr: string;
  readonly stdout: string;
};

export function runWithSpilledStdout(
  command: string,
  arguments_: readonly string[],
  stderrMaxBuffer = 16 * 1024 * 1024,
): SpilledProcessResult {
  const directory = mkdtempSync(join(tmpdir(), "z-process-output-"));
  const outputPath = join(directory, "stdout");
  let output = openSync(outputPath, "w");
  try {
    const result = spawnSync(command, [...arguments_], {
      encoding: "utf8",
      stdio: ["ignore", output, "pipe"],
      // Only diagnostics remain piped. Potentially large machine-readable
      // output is captured by the spill file without a child-process cap.
      maxBuffer: stderrMaxBuffer,
    });
    closeSync(output);
    output = -1;
    return {
      status: result.status,
      error: result.error,
      stderr: result.stderr ?? "",
      stdout: readFileSync(outputPath, "utf8"),
    };
  } finally {
    if (output >= 0) closeSync(output);
    rmSync(directory, { recursive: true, force: true });
  }
}

export function runWithBufferedStdoutOrSpill(
  command: string,
  arguments_: readonly string[],
  stdoutMaxBuffer: number,
): SpilledProcessResult {
  const buffered = spawnSync(command, [...arguments_], {
    encoding: "utf8",
    maxBuffer: stdoutMaxBuffer,
  });
  const overflowed = isProcessOutputOverflowError(buffered.error);
  if (overflowed) return runWithSpilledStdout(command, arguments_);
  return {
    status: buffered.status,
    error: buffered.error,
    stderr: buffered.stderr ?? "",
    stdout: buffered.stdout ?? "",
  };
}

export function isProcessOutputOverflowError(error: Error | undefined): boolean {
  if (!error) return false;
  const code = (error as Error & { readonly code?: string }).code;
  return code === "ENOBUFS"
    || code === "ERR_STRING_TOO_LONG"
    || error.message.includes("maxBuffer")
    || error.message.includes("Cannot create a string longer than")
    || error.message.includes("Invalid string length");
}
