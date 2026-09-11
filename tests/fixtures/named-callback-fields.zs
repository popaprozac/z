import console from "std/console";
import { thread } from "std/thread";

type Callback = () => i32 on thread.main;

function initial(): i32 on thread.main { return 20; }
function replacement(): i32 on thread.main { return 22; }

struct Value {
  callback: Callback;

  static function create(): Value on thread.main {
    return Value({ callback: initial });
  }

  function reset(inout this): void on thread.main {
    this.callback = replacement;
  }
}

class Controller on thread.main {
  callback: Callback;

  constructor() { this.callback = initial; }

  function reset(inout this): void {
    this.callback = replacement;
  }
}

function main(): i32 on thread.main {
  let value = Value.create();
  const controller = new Controller();
  if (value.callback() + controller.callback() != 40) return 1;
  value.reset();
  controller.reset();
  if (value.callback() + controller.callback() != 44) return 2;
  console.log("callbacks reset");
  return 0;
}
