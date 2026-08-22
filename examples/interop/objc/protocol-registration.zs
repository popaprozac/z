import WebKit from "WebKit/WebKit.h";
import objc from "std/objc";
import { thread } from "std/thread";

class MessageHandler on thread.main implements WebKit.WKScriptMessageHandler {
  function receive(
    in controller: WebKit.WKUserContentController,
    in message: WebKit.WKScriptMessage
  ): void as "userContentController:didReceiveScriptMessage:" {
    // Decode and route message.body here. The registration token keeps this
    // Z controller and its generated Objective-C adapter alive.
  }
}

function main(): i32 {
  const contentController = WebKit.WKUserContentController.alloc().init();
  const handler = new MessageHandler({});
  const registration = objc.register({
    add: contentController.addScriptMessageHandler(handler, "zapp"),
    remove: contentController.removeScriptMessageHandlerForName("zapp"),
  });
  return 0;
}
