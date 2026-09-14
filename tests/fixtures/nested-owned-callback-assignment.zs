import console from "std/console";

function idle(): void {}

class Pending {
  callback: () => void;

  function close(inout this): void { this.callback = idle; }

  deinit {
    this.close();
    console.log("closed pending");
  }
}

function install(inout pending: Pending, token: String, realm: String): void {
  pending.callback = move (): void => {
    const tokenSnapshot = copy token;
    const realmSnapshot = copy realm;
    const nested: () => void = move (): void => {
      console.log(tokenSnapshot);
      console.log(realmSnapshot);
    };
    nested();
  };
}

function main(): i32 {
  let pending = new Pending({ callback: idle });
  install(inout pending, "token", "realm");
  pending.callback();
  return 0;
}
