function defaultAttempts(): i32 {
  return 1;
}

export struct Envelope<T> {
  value: T;
  attempts: i32 = defaultAttempts();
  history: Array<T> = Array<T>();
}
