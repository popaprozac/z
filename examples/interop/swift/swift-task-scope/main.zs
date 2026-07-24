import console from "std/console";
import { thread } from "std/thread";
import { delay } from "std/time";
import AppKit from "AppKit/AppKit.h";
import Swift from "ZSwiftTaskScope-Swift.h";

async function main(): i32 {
  const value = await Swift.ZSwiftBackgroundWorker.calculate(40);
  const checked = attempt await Swift.ZSwiftBackgroundWorker.calculateChecked(
    40,
    shouldFail: false
  );
  const checkedValue = match (checked) {
    success(value) => value;
    failure(error) => {
      console.log(error.code);
      select 0;
    }
  };
  const failed = attempt await Swift.ZSwiftBackgroundWorker.calculateChecked(
    40,
    shouldFail: true
  );
  const failureStatus = match (failed) {
    success(value) => value;
    failure(error) => {
      console.log(error.code);
      select 0;
    }
  };
  await on thread.main {
    const label = AppKit.NSTextField.alloc().initWithFrame(
      AppKit.NSMakeRect(0.0, 0.0, 240.0, 24.0)
    );
    label.sizeToFit();
    console.log(value);
  }
  const cancelled = task Swift.ZSwiftBackgroundWorker.calculateDelayed(1);
  await delay(1);
  await cancelled.cancel();
  return value - 42 + checkedValue - 42 + failureStatus;
}
