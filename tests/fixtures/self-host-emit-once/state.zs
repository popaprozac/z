import { Once } from "std/sync";
import { thread } from "std/thread";
import console from "std/console";

export class Application on thread.main {
  readonly id: i32;

  deinit {
    console.log(`released ${this.id}`);
  }
}

export const application: Once<Application> = Once<Application>();
