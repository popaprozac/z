import { TaskControl } from "std/async";
import { Map } from "std/collections";

struct Request {
  generation: u64;
  control: Option<TaskControl>;
}

function main(): i32 {
  let requests = Map<u64, Request>();
  requests.set(
    1,
    Request({
      generation: 1,
      control: Option<TaskControl>.none,
    })
  );

  const found = requests.remove(1);
  return match (found) {
    some(value) => {
      let request = value;
      if (request.generation == 0) return 3;
      requests.set(1, request);
      select requests.has(1) ? 0 : 1;
    }
    none => 2;
  };
}
