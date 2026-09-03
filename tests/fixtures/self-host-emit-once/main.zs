import { Application, application } from "./state.zs";
import { OnceState } from "std/sync";

function main(): i32 {
  if (application.state() != OnceState.empty) return 1;
  {
    const lifetime = application.initialize(
      new Application({ id: 42 })
    );
    if (application.state() != OnceState.initialized) return 2;
    const current = application.get();
    if (current.id != 42) return 3;
  }
  return application.state() == OnceState.closed ? 0 : 4;
}
