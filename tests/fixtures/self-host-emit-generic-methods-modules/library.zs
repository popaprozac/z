export struct Holder<T> {
  value: T;

  function preserve<U>(value: U): U {
    return value;
  }
}
