import { setDefaultTimeout } from "bun:test";

const configuredTimeout = Number(process.env.Z_BUN_TEST_TIMEOUT_MS ?? "60000");

if (!Number.isFinite(configuredTimeout) || configuredTimeout <= 0) {
  throw new Error("Z_BUN_TEST_TIMEOUT_MS must be a positive number");
}

setDefaultTimeout(configuredTimeout);
