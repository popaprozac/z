import console from "std/console";

struct RequestOptions {
  retries: i32 = 3;
  timeoutMilliseconds: i32 = 1000;
  headers: Array<String> = Array<String>();
}

function main(): i32 {
  const defaults = RequestOptions();
  const equivalent = RequestOptions({});
  const patient = RequestOptions({ timeoutMilliseconds: 5000 });

  console.log(
    `defaults=${defaults.retries}, equivalent=${equivalent.retries}, timeout=${patient.timeoutMilliseconds}`
  );
  return 0;
}
