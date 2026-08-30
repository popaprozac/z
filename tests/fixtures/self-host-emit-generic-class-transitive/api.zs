import {
  Events as FrameworkEvents,
  createEvents as createFrameworkEvents,
  runCallback as runFrameworkCallback,
} from "./library.zs";

export type Events = FrameworkEvents;

export function makeEvents(value: i32): Events {
  return createFrameworkEvents(value);
}

export function executeCallback(callback: () => void): void {
  runFrameworkCallback(callback);
}
