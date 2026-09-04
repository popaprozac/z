import { thread } from "std/thread";
import { Command, CommandAction } from "./api.zs";

class Controller on thread.main {
  value: i32;

  function read(): i32 {
    return this.value;
  }
}

async function main(): i32 on thread.main {
  const controller = new Controller({ value: 42 });
  const command = new Command({ value: 0 });
  const action: CommandAction = move (): void => {
    controller.read();
  };
  action();
  return command.value;
}
