struct SubscriptionError {
  code: i32;
}

struct Record {
  label: String;
  tags: Array<String>;
}

type Handler = (in value: i32) => void;

function subscribe(handler: Handler): i32 throws SubscriptionError {
  const value = 42;
  handler(in value);
  return 1;
}

function run(): i32 throws SubscriptionError {
  const subscription = try subscribe(
    move (in value: i32): void => {
      if (value != 42) return;
    }
  );
  const found = Option.some(Record({
    label: "native",
    tags: Array<String>("owned"),
  }));
  const status = match (found) {
    some(record) => {
      let current = record;
      let observed = subscription - 1;
      if (current.label != "native") observed = 2;
      if (current.tags[0] != "owned") observed = 3;
      select observed;
    }
    none => 4;
  };
  return status;
}

function main(): i32 {
  return match (attempt run()) {
    success(status) => status;
    failure(_) => 5;
  };
}
