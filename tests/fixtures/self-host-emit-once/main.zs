import { Application, application } from "./state.zs";

function main(): i32 {
  {
    const lifetime = application.initialize(
      new Application({ id: 42 })
    );
    const current = application.get();
    if (current.id != 42) return 1;
  }
  return 0;
}
