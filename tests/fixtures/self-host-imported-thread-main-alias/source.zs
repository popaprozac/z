import { thread } from "std/thread";

export type FrameworkAction = () => void on thread.main;

export class FrameworkCommand on thread.main {
  readonly value: i32;
}
