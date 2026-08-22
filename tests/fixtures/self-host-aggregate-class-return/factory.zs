export class Application {
  value: i32;
}

export struct Context {
  application: Application;
}

export enum Selection {
  preferred i32,
  fallback,
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

export function wrapMatch(
  in application: Application,
  selection: Selection
): Context {
  match (selection) {
    preferred(code) => return Context({ application });
    fallback => return Context({ application });
  }
}
