export function equal<T>(in left: Array<T>, in right: Array<T>): boolean {
  return left[0] == right[0];
}

export function forwarded<T>(in left: Array<T>, in right: Array<T>): boolean {
  return equal<T>(left, right);
}

export struct Checker<T> {
  function same(in left: Array<T>, in right: Array<T>): boolean {
    return left[0] == right[0];
  }
}

export struct MethodChecker {
  function different<T>(in left: Array<T>, in right: Array<T>): boolean {
    return left[0] != right[0];
  }
}
