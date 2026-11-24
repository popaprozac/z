// Generic bodies whose locals have types nothing spells out: the Option a
// collection method returns, the Result of an `attempt`. Each instance needs
// those types defined for its own arguments.

export enum Empty { nothing }

export struct Pool<T> {
  values: Array<T>;

  function add(inout this, value: T): usize {
    this.values.push(move value);
    return this.values.length;
  }

  function take(inout this): Option<T> {
    const popped = this.values.pop();
    return popped;
  }

  function drain(inout this): usize {
    let taken: usize = 0;
    while (true) {
      const next = this.values.pop();
      match (next) {
        some(value) => { taken = taken + 1; }
        none => { return taken; }
      }
    }
    return taken;
  }
}

export class Stack<T> {
  values: Array<T>;

  function push(inout this, value: T): void {
    this.values.push(move value);
  }

  function depthAfterPop(inout this): usize {
    const popped = this.values.pop();
    match (popped) {
      some(value) => { return this.values.length; }
      none => { return 0; }
    }
  }
}

export function takeLast<T>(inout values: Array<T>): T throws Empty {
  const popped = values.pop();
  match (popped) {
    some(value) => { return value; }
    none => { throw Empty.nothing; }
  }
}

export function lastOr<T>(inout values: Array<T>, fallback: T): T {
  const outcome = attempt takeLast(inout values);
  match (outcome) {
    success(value) => { return value; }
    failure(_) => { return fallback; }
  }
}
