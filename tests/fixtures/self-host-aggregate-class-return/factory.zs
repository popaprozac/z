export class Application {
  value: i32;
}

export struct Context {
  application: Application;
}

export function wrap(in application: Application): Context {
  return Context({ application });
}

export function wrapBranch(
  in application: Application,
  usePreferred: boolean
): Context {
  if (usePreferred) return Context({ application });
  else return Context({ application });
}
