import { Application } from "./model.zs";

function main(): i32 {
  let app = Application({ name: "Defaults" });
  app.builder.values.push(42);
  return app.builder.values[0] - 42;
}
