class Application {
  value: i32;
}

struct Context {
  application: Application;
}

enum Selection {
  preferred i32,
  fallback,
}

function wrap(in application: Application, selection: Selection): Context {
  match (selection) {
    preferred(code) => return Context({ application });
    fallback => return Context({ application });
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
  const context = wrap(preview, Selection.preferred(42));
  return updateAndInspect(inout application, context.application) - 1;
}
