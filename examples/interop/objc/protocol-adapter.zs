import WebKit from "WebKit/WebKit.h";
import objc from "std/objc";
import { thread } from "std/thread";

class SchemeHandler on thread.main implements WebKit.WKURLSchemeHandler {
  function start(
    in webView: WebKit.WKWebView,
    in task: WebKit.WKURLSchemeTask
  ): void as "webView:startURLSchemeTask:" {
    // A protocol-qualified id<P> safely widens to Objective-C's ordinary id.
    WebKit.NSArray.arrayWithObject(task);
    task.didFinish();
  }

  function stop(
    in webView: WebKit.WKWebView,
    in task: WebKit.WKURLSchemeTask
  ): void as "webView:stopURLSchemeTask:" {}
}

class SchemeHandlerOwner on thread.main {
  readonly id: i32;
  readonly adapter: objc.Adapter<WebKit.WKURLSchemeHandler>;
}

function main(): i32 {
  const handler = new SchemeHandler({});
  const adapter = objc.adapt<WebKit.WKURLSchemeHandler>(handler);
  const owner = new SchemeHandlerOwner({ id: 1, adapter });
  const configuration = WebKit.WKWebViewConfiguration.alloc().init();
  configuration.setURLSchemeHandler(owner.adapter, forURLScheme: "z-example");
  return 0;
}
