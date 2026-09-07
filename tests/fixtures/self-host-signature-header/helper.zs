import native from "./native.h";

// Still emitted even though no call site requires the imported header.
function inspect(value: native.SignatureOnly): void {}

export function result(): i32 { return 0; }
