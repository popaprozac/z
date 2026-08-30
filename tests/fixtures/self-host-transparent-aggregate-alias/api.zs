import {
  NativeFailure as FrameworkFailure,
  Worker as FrameworkWorker,
  makeWorker,
} from "./model.zs";

export type PublicFailure = FrameworkFailure;
export type NativeFailure = FrameworkFailure;
export type Worker = FrameworkWorker;

export function createWorker(): Worker {
  return makeWorker();
}
