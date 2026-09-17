import { Failure as ImportedFailure, Callback } from "./errors.zs";
import errors from "./errors.zs";
import { ForwardedFailure, ForwardedCallback } from "./forward.zs";

// A same-spelled local type must not replace the imported error's identity.
struct Failure { code: i32; }

function main(): i32 {
  const named: Callback = move (): i32 throws ImportedFailure => {
    throw ImportedFailure({ message: "named" });
  };
  const qualified = (): i32 throws errors.Failure => {
    throw errors.Failure({ message: "qualified" });
  };
  const forwarded: ForwardedCallback = move (): i32 throws ForwardedFailure => {
    throw ForwardedFailure({ message: "forwarded" });
  };
  match (attempt named()) { success(_) => return 1; failure(error) => { if (error.message != "named") return 2; } }
  match (attempt qualified()) { success(_) => return 3; failure(error) => { if (error.message != "qualified") return 4; } }
  match (attempt forwarded()) { success(_) => return 5; failure(error) => { if (error.message != "forwarded") return 6; } }
  return 0;
}
