import { Message, State } from "./message.zs";
import { thread } from "std/thread";

export type PublicState = State;

export type Handler = (
  in message: Message,
  code: i32
) => void on thread.main;

export function handle(
  in message: Message,
  code: i32
): void on thread.main {}

export function currentState(): PublicState {
  return State.running;
}
