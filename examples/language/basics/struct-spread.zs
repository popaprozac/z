import console from "std/console";

struct RetryPolicy {
  attempts: i32 = 3;
  timeoutMilliseconds: i32 = 1000;
}

struct RequestOptions {
  endpoint: String;
  method: String = "GET";
  retries: RetryPolicy = RetryPolicy();
}

function main(): i32 {
  const baselinePolicy = RetryPolicy();
  const patientPolicy = RetryPolicy({
    ...baselinePolicy,
    timeoutMilliseconds: 2500,
  });

  const incoming = RequestOptions({
    endpoint: "/notes",
    retries: patientPolicy,
  });
  const snapshot = RequestOptions({
    copy ...incoming,
    method: "HEAD",
  });
  const prepared = RequestOptions({
    move ...snapshot,
    endpoint: "/notes/active",
  });

  console.log(`${incoming.method} ${incoming.endpoint}; ${prepared.method} ${prepared.endpoint}; timeout=${prepared.retries.timeoutMilliseconds}`);

  return prepared.retries.timeoutMilliseconds - 2500;
}
