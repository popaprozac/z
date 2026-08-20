struct Holder<T> {
  value: T;

  function choose<U>(takeLeft: boolean, left: U, right: U): U {
    if (takeLeft) return left;
    return right;
  }

}

struct GenericMethodError {
  code: i32;
}

class IdentityStore {
  label: String;

  function preserve<T>(value: T): T {
    return value;
  }
}

struct Utility {
  static function preserve<T>(value: T): T {
    return value;
  }

  static function require<T>(value: T, fail: boolean): T throws GenericMethodError {
    if (fail) throw GenericMethodError({ code: 1 });
    return value;
  }
}

function main(): i32 {
  const holder = Holder({ value: 1 });
  const inferred = holder.choose(true, 20, 0);
  const explicitMethod = holder.choose<i32>(true, 1, 0);
  const explicit = Utility.preserve<i32>(22);
  const words = Holder({ value: "owner" });
  const selected = words.choose(false, "unused", "owned");
  if (selected != "owned") return 1;
  const store = new IdentityStore({ label: "identity" });
  const classSelected = store.preserve<String>("class");
  if (classSelected != "class") return 3;
  const required = attempt Utility.require<String>("safe", false);
  const status = match (required) {
    success(value) => {
      if (value != "safe") return 2;
      select 0;
    }
    failure(error) => error.code;
  };
  return inferred + explicit + explicitMethod - 43 + status;
}
