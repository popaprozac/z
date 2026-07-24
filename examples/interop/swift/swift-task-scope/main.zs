import console from "std/console";
import { thread } from "std/thread";
import { delay } from "std/time";
import AppKit from "AppKit/AppKit.h";
import Swift from "ZSwiftTaskScope-Swift.h";

async function main(): i32 {
  const value = await Swift.ZSwiftBackgroundWorker.calculate(40);
  await on thread.main {
    const label = AppKit.NSTextField.alloc().initWithFrame(
      AppKit.NSMakeRect(0.0, 0.0, 240.0, 24.0)
    );
    label.sizeToFit();
    console.log(value);
  }
  const cancelled = spawn Swift.ZSwiftBackgroundWorker.calculateDelayed(1);
  await delay(1);
  await cancelled.cancel();
  return value - 42;
}
