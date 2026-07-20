public enum LoadState {
  case idle
  case ready(Int32)

  public func value() -> Int32 {
    switch self {
    case .idle:
      return -1
    case .ready(let value):
      return value
    }
  }
}
