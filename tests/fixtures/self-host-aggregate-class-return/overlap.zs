import { Application, wrap } from "./factory.zs";

function updateAndInspect(
  inout updated: Application,
  in observed: Application
): i32 {
  updated.value = updated.value + 1;
  return observed.value;
}

function main(): i32 {
  let application = new Application({ value: 41 });
  const context = wrap(application);
  return updateAndInspect(inout application, context.application);
}
