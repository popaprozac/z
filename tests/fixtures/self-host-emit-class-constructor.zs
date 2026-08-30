class Manager {
  readonly value: i32;

  private constructor(value: i32) {
    this.value = value;
  }

  static function create(value: i32): Manager {
    return new Manager(value);
  }
}

class Window {
  readonly title: String;
  readonly manager: Weak<Manager>;

  constructor(title: String, manager: Weak<Manager>) {
    this.title = move title;
    this.manager = manager;
  }
}

enum WindowResult {
  success Window,
  failure i32,
}

function createWindow(title: String, manager: Weak<Manager>): WindowResult {
  return WindowResult.success(new Window(move title, manager));
}

function main(): i32 {
  const manager = Manager.create(42);
  const observer = weak manager;
  const created = createWindow("Native constructor", observer);
  const window = match (created) {
    success(value) => value;
    failure(_) => return 1;
  };
  const current = attempt window.manager.upgrade();
  const value = match (current) {
    success(owner) => owner.value;
    failure(_) => 0;
  };
  return value + i32(window.title.byteLength) - 60;
}
