class Application {
  value: i32;
}

struct Context {
  application: Application;
}

function wrap(
  in primary: Application,
  in alternate: Application,
  condition: boolean
): Context {
  if (condition) return Context({ application: primary });
  return Context({ application: alternate });
}

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
  const context = wrap(preview, application, true);
  return updateAndInspect(inout application, context.application);
}
