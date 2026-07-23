import console from "std/console";
import { AsyncGenerator } from "std/iteration";
import { delay } from "std/time";

struct Event {
  id: i32;
}

struct StreamSummary {
  emitted: i32;
  heartbeats: i32;
}

struct StreamError {
  code: i32;
}

enum Incoming {
  event Event,
  heartbeat i32,
}

async function readEvents(
  records: Array<Incoming>
): AsyncGenerator<Event, StreamSummary, StreamError> throws StreamError {
  let connectionAttempts = 0;
  while (connectionAttempts < 2) {
    await delay(1);
    connectionAttempts = connectionAttempts + 1;
  }

  let emitted = 0;
  let heartbeats = 0;
  for (const record of records) {
    await delay(1);
    match (in record) {
      event(event) => {
        if (event.id < 0) throw StreamError({ code: event.id });
        yield copy event;
        emitted = emitted + 1;
      }
      heartbeat(code) => {
        heartbeats = heartbeats + code;
      }
    }
  }

  return StreamSummary({ emitted, heartbeats });
}

async function main(): i32 throws StreamError {
  let incoming = Array<Incoming>();
  incoming.push(Incoming.heartbeat(1));
  incoming.push(Incoming.event(Event({ id: 20 })));
  incoming.push(Incoming.event(Event({ id: 22 })));

  const events = readEvents(move incoming);
  const first = try await events.next();
  const second = try await events.next();
  const terminal = try await events.next();

  const firstId = match (first) {
    yielded(event) => event.id;
    complete(summary) => 0;
  };
  const secondId = match (second) {
    yielded(event) => event.id;
    complete(summary) => 0;
  };
  const summaryValue = match (terminal) {
    yielded(event) => 0;
    complete(summary) => summary.emitted + summary.heartbeats;
  };

  console.log(`streamed ${firstId}, ${secondId}; summary=${summaryValue}`);
  return firstId + secondId + summaryValue - 45;
}
