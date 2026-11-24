// A generic aggregate here is instantiated by a module with a type that
// module keeps private. This module also has a generic function and a
// generic method in use, each lowered in a later pass of its own; every
// pass has to know the private argument type to lay `Pool<Entity>` out.

export struct Pool<T> {
  values: Array<T>;

  function count(): usize {
    return this.values.length;
  }

  function countWith<U>(in extra: Array<U>): usize {
    return this.values.length + extra.length;
  }
}

export function first<T>(in values: Array<T>, fallback: T): T {
  if (values.length > 0) return copy values[0];
  return fallback;
}
