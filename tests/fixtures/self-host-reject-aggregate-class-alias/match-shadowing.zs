class Application {
  value: i32;
}

struct Context {
  application: Application;
}

enum Selection {
  chosen Application,
  fallback Application,
}

function wrap(
  in application: Application,
  selection: Selection
): Context {
  match (selection) {
    chosen(application) => return Context({ application });
    fallback(application) => return Context({ application });
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
  const context = wrap(preview, Selection.chosen(application));
  return updateAndInspect(inout application, context.application);
}
