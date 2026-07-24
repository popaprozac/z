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

  @objc(waitForCompletion)
  public static func waitForCompletion() {
    work.wait()
  }
}
