import console from "std/console";
import { thread } from "std/thread";
import AppKit from "AppKit/AppKit.h";
import Swift from "ZSwiftTaskScope-Swift.h";

async function main(): i32 {
  async scope updates {
    Swift.ZSwiftBackgroundWorker.calculate(
      40,
      completion: move (value) => {
        const accepted = updates.spawn(
          thread.main,
          move (): void => {
            const label = AppKit.NSTextField.alloc().initWithFrame(
              AppKit.NSMakeRect(0.0, 0.0, 240.0, 24.0)
            );
            label.stringValue = `Swift background result=${value}`;
            console.log(label.stringValue);
          }
        );
        if (!accepted) return;
      }
    );
    Swift.ZSwiftBackgroundWorker.waitForCompletion();
  }
  return 0;
}
