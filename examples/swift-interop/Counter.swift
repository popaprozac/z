import Foundation

@objc(ZSwiftCounter)
public final class SwiftCounter: NSObject {
  @objc public var value: Int32

  @objc public init(value: Int32) {
    self.value = value
    super.init()
  }

  @objc public func add(_ amount: Int32) -> Int32 {
    value += amount
    return value
  }
}
