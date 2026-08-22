class Application {
  value: i32;
}

struct Context {
  application: Application;
}

enum Selection {
  primary,
  alternate,
}

function wrap(
  in primary: Application,
  in alternate: Application,
  selection: Selection
): Context {
  match (selection) {
    primary => return Context({ application: primary });
    alternate => return Context({ application: alternate });
  }
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
  const context = wrap(preview, application, Selection.primary);
  return updateAndInspect(inout application, context.application);
}
