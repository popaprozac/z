import { Once, OnceLifetime } from "std/sync";
import { thread } from "std/thread";

export class Application on thread.main {
  readonly name: String;
  readonly revision: i32;
}

const application = Once<Application>();

export function initializeApplication(
  value: Application
): OnceLifetime<Application> on thread.main {
  return application.initialize(move value);
}

export function currentApplication(): Application on thread.main {
  return application.get();
}
