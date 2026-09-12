import console from "std/console";

function forward(value: Weak<Manager>): Weak<Manager> { return value; }
function reject(value: Weak<Manager>): void throws i32 { throw 17; }

class Manager {
  function observer(): Weak<Manager> { return forward(weak this); }
  function rejected(): void throws i32 { try reject(weak this); }
}

class Owner<T> {
  value: T;
  function observer(): Weak<Owner<T>> {
    return weak this;
  }
  deinit { console.log("released owner"); }
}

function make(): Weak<Owner<i32>> throws WeakExpired {
  const owner = new Owner<i32>({ value: 42 });
  const observer = owner.observer();
  const alive = try observer.upgrade();
  if (alive.value != 42) console.log("unexpected value");
  return observer;
}

function main(): i32 {
  const manager = new Manager({});
  const weakManager = manager.observer();
  match (attempt manager.rejected()) {
    success => return 7;
    failure(error) => if (error != 17) return 6;
  }
  match (attempt weakManager.upgrade()) {
    success(_) => {}
    failure(_) => return 8;
  }
  const observer = match (attempt make()) {
    success(value) => value;
    failure(_) => return 9;
  };
  return match (attempt observer.upgrade()) {
    success(_) => 1;
    failure(_) => 0;
  };
}
