import WebKit from "WebKit/WebKit.h";
import { thread } from "std/thread";

// A block received through an Objective-C protocol callback is an ordinary
// typed Z callable. `in` borrows the native block for this invocation; storing
// the callable makes an ARC-managed native copy.
class NavigationHandler on thread.main implements WebKit.WKNavigationDelegate {
  function decidePolicyForNavigationAction(
    in webView: WebKit.WKWebView,
    in navigationAction: WebKit.WKNavigationAction,
    in decisionHandler: (policy: WebKit.WKNavigationActionPolicy) => void
  ): void as "webView:decidePolicyForNavigationAction:decisionHandler:" {
    decisionHandler(WebKit.WKNavigationActionPolicyAllow);
  }
}

function main(): i32 {
  return 0;
}
