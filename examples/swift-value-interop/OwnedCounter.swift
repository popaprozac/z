private final class LifetimeProbe {
  let id: Int32

  init(id: Int32) {
    self.id = id
    print("created \(id)")
  }

  deinit {
    print("released \(id)")
  }
}

public struct OwnedCounter {
  public var value: Int32
  private let lifetime: LifetimeProbe

  public init(value: Int32) {
    self.value = value
    self.lifetime = LifetimeProbe(id: value)
  }
}

public func makeOwnedCounter(_ value: Int32) -> OwnedCounter {
  OwnedCounter(value: value)
}

public func readOwnedCounter(_ counter: OwnedCounter) -> Int32 {
  counter.value
}

public func offsetOwnedCounter(_ counter: OwnedCounter, _ amount: Int32) -> OwnedCounter {
  var copy = counter
  copy.value += amount
  return copy
}

public func roundTrip(_ counter: OwnedCounter) -> OwnedCounter {
  counter
}
