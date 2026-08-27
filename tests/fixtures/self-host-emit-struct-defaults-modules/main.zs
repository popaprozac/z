import { Application } from "./model.zs";

function main(): i32 {
  let app = Application();
  app.builder.values.push(42);
  if (app.name != "Defaults") return 1;
  return app.builder.values[0] - 42;
}
