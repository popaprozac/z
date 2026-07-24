import Dispatch
import Foundation

@objc(ZSwiftBackgroundWorker)
public final class SwiftBackgroundWorker: NSObject {
  private static let work = DispatchGroup()

  @objc(calculate:completion:)
  public static func calculate(
    _ value: Int32,
    completion: @escaping @Sendable (Int32) -> Void
  ) {
    work.enter()
    DispatchQueue.global(qos: .userInitiated).async {
      completion(value + 2)
      work.leave()
    }
  }

  @objc(calculateDelayed:completion:)
  public static func calculateDelayed(
    _ value: Int32,
    completion: @escaping @Sendable (Int32) -> Void
  ) {
    work.enter()
    DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + .milliseconds(30)) {
      completion(value + 2)
      work.leave()
    }
  }

  @objc(calculateChecked:shouldFail:completion:)
  public static func calculateChecked(
    _ value: Int32,
    shouldFail: Bool,
    completion: @escaping @Sendable (Int32, NSError?) -> Void
  ) {
    work.enter()
    DispatchQueue.global(qos: .userInitiated).async {
      if shouldFail {
        completion(
          0,
          NSError(
            domain: "ZSwiftTaskScope",
            code: 7,
            userInfo: [NSLocalizedDescriptionKey: "the requested calculation failed"]
          )
        )
      } else {
        completion(value + 2, nil)
      }
      work.leave()
    }
  }

  @objc(waitForCompletion)
  public static func waitForCompletion() {
    work.wait()
  }
}
