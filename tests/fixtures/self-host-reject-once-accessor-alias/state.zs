import { Once } from "std/sync";
import { thread } from "std/thread";

export class Application {
  value: i32;
  marker: i32 on thread.main;

  function increment(inout this): void on thread.main {
    this.value = this.value + 1;
  }

  function read(): i32 on thread.main {
    return this.value;
  }
}

const application = Once<Application>();
const previewApplicationCell = Once<Application>();

export function currentApplication(): Application {
  return application.get();
}

export function previewApplication(): Application {
  return previewApplicationCell.get();
}
