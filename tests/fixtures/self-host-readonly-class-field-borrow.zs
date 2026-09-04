class Command {
  readonly id: i32;
}

readonly struct Menu {
  command: Command;
}

readonly class Application {
  menu: Menu;
}

function currentApplication(): Application {
  return new Application({
    menu: Menu({ command: new Command({ id: 42 }) }),
  });
}

function inspect(in menu: Menu): i32 {
  return menu.command.id;
}

function main(): i32 {
  const application = currentApplication();
  return inspect(in application.menu) - 42;
}
