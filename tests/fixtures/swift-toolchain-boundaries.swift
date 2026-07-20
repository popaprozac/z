public struct UniqueCounter: ~Copyable {
  private var value: Int32

  public init(value: Int32) {
    self.value = value
  }

  public borrowing func read() -> Int32 {
    value
  }

  public consuming func finish() -> Int32 {
    value
  }
}

public func makeUniqueCounter(_ value: Int32) -> UniqueCounter {
  UniqueCounter(value: value)
}

public func doubleLater(_ value: Int32) async -> Int32 {
  value * 2
}
