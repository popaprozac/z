import console from "std/console";

class Session {
  id: i32;

  deinit {
    console.log(`released session ${this.id}`);
  }
}

class Controller {
  id: i32;
  handler: () => i32;

  function install(inout this): void {
    const owner = weak this;
    const installed: () => i32 = move (): i32 => readController(owner);
    this.handler = installed;
  }

  deinit {
    console.log(`released controller ${this.id}`);
  }
}

class SessionObserver {
  session: Weak<Session>;
}

function emptyHandler(): i32 {
  return 0;
}

function readController(in observer: Weak<Controller>): i32 {
  const upgraded = attempt observer.upgrade();
  return match (upgraded) {
    success(controller) => controller.id;
    failure(expired) => -1;
  };
}

function read(in observer: Weak<Session>): i32 {
  const upgraded = attempt observer.upgrade();
  return match (upgraded) {
    success(session) => session.id;
    failure(expired) => -1;
  };
}

function require(in observer: Weak<Session>): i32 throws WeakExpired {
  const session = try observer.upgrade();
  return session.id;
}

function copyObserver(observer: Weak<Session>): i32 {
  return read(observer);
}

function main(): i32 {
  let current = new Session({ id: 42 });
  const observer = weak current;
  const sharedObserver = observer;
  const storedObserver = new SessionObserver({ session: observer });

  const alive = copyObserver(sharedObserver);
  if (read(storedObserver.session) != 42) return 1;
  const required = attempt require(observer);
  const requiredValue = match (required) {
    success(value) => value;
    failure(expired) => -1;
  };

  current = new Session({ id: 7 });
  const expired = read(observer);
  if (
    alive != 42
    || requiredValue != 42
    || expired != -1
    || read(storedObserver.session) != -1
  ) return 1;

  let handler: () => i32 = emptyHandler;
  {
    let controller = new Controller({ id: 9, handler: emptyHandler });
    controller.install();
    handler = controller.handler;
    if (handler() != 9) return 2;
  }
  if (handler() != -1) return 3;
  return 0;
}
