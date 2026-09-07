import console from "std/console";

struct Resource {
  label: String;

  deinit {
    console.log(`released ${this.label}`);
  }
}

function acquire(label: String, fail: boolean): Option<Resource> throws String {
  if (fail) throw "creation failed";
  return Option.some(Resource({ label: move label }));
}

function inspect(mode: i32): void throws String {
  match (try acquire("statement", false)) {
    some(_) => {
      if (mode == 1) throw "arm failed";
      if (mode == 2) return;
    }
    none => {}
  }
}

function selected(): i32 throws String {
  const result = match (try acquire("selected", false)) {
    some(resource) => resource.label == "selected" ? 7 : 0;
    none => 0;
  };
  return result;
}

function returned(): i32 throws String {
  return match (try acquire("returned", false)) {
    some(resource) => resource.label == "returned" ? 8 : 0;
    none => 0;
  };
}

function borrowed(early: boolean): i32 throws String {
  const resource = try acquire("borrowed", false);
  match (in resource) {
    some(resource) => {
      if (early) return resource.label == "borrowed" ? 9 : 0;
    }
    none => {}
  }
  return 10;
}

function failed(): void throws String {
  match (try acquire("not-created", true)) {
    some(_) => throw "unexpected value";
    none => {}
  }
}

function borrowedReturned(): i32 throws String {
  const resource = try acquire("borrowed returned", false);
  return match (in resource) {
    some(resource) => resource.label == "borrowed returned" ? 11 : 0;
    none => 0;
  };
}

function shadowed(): i32 throws String {
  const resource = Resource({ label: "outer" });
  const selected = match (try acquire("inner", false)) {
    some(resource) => resource;
    none => return 0;
  };
  if (resource.label != "outer" || selected.label != "inner") return 0;
  return 12;
}

function label(): String throws String {
  return "constructed";
}

function constructed(): i32 throws String {
  const resource = Resource({ label: try label() });
  if (resource.label != "constructed") return 0;
  return 13;
}

function run(): i32 throws String {
  try inspect(0);
  const observed = attempt inspect(1);
  match (in observed) {
    success => return 1;
    failure(error) => { if (error != "arm failed") return 2; }
  }
  try inspect(2);
  if (try selected() != 7) return 3;
  if (try returned() != 8) return 4;
  if (try borrowed(true) != 9) return 5;
  if (try borrowed(false) != 10) return 6;
  const failure = attempt failed();
  match (in failure) {
    success => return 7;
    failure(error) => { if (error != "creation failed") return 8; }
  }
  if (try borrowedReturned() != 11) return 10;
  if (try shadowed() != 12) return 11;
  if (try constructed() != 13) return 12;
  return 0;
}

function main(): i32 {
  return match (attempt run()) {
    success(value) => value;
    failure(_) => 9;
  };
}
