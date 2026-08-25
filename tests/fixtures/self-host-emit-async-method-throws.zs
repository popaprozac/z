struct DecodeError {
  code: i32;
}

readonly class Decoder {
  readonly shouldFail: boolean;

  async function decode(): i32 throws DecodeError {
    if (this.shouldFail) throw DecodeError({ code: 42 });
    return 7;
  }
}

async function main(): i32 {
  const failing = new Decoder({ shouldFail: true });
  const result = attempt await failing.decode();
  return match (result) {
    success(_) => 1;
    failure(problem) => problem.code == 42 ? 0 : 2;
  };
}
