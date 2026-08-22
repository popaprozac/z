import {
  Application,
  Selection,
  wrapMatch,
} from "./factory.zs";

function updateAndInspect(
  inout updated: Application,
  in observed: Application
): i32 {
  updated.value = updated.value + 1;
  return observed.value;
}

function main(): i32 {
  let application = new Application({ value: 41 });
  const preview = new Application({ value: 1 });
  const context = wrapMatch(preview, Selection.preferred(42));
  return updateAndInspect(inout application, context.application) - 1;
}
