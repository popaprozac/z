import console from "std/console";

struct BuildError {
  code: i32;
}

struct Item {
  id: i32;

  deinit {
    console.log(`drop ${this.id}`);
  }
}

function createItem(id: i32, shouldFail: boolean): Item throws BuildError {
  if (shouldFail) throw BuildError({ code: 7 });
  return Item({ id });
}

function createItems(shouldFail: boolean): Item[2] throws BuildError {
  return [
    try createItem(1, false),
    try createItem(2, shouldFail),
  ];
}

function main(): i32 {
  const failed = attempt createItems(true);
  const failureCode = match (failed) {
    success(items) => {
      return items[0].id;
    }
    failure(error) => error.code;
  };
  if (failureCode != 7) return 1;

  const created = attempt createItems(false);
  return match (created) {
    success(items) => {
      if (items[0].id != 1 || items[1].id != 2) return 2;
      const names: String[2] = ["alpha", "beta"];
      const copiedNames = copy names;
      if (
        copiedNames[0].byteLength != 5
        || copiedNames[1].byteLength != 4
      ) return 3;
      return 0;
    }
    failure(error) => return error.code;
  };
}
