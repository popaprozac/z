struct DecodeError {
  code: i32;
}

class Decoder {
  value: i32;

  function decode(fail: boolean): i32 throws DecodeError {
    if (fail) throw DecodeError({ code: 1 });
    return this.value;
  }

  function unused(): i32 throws DecodeError {
    return this.value;
  }
}

function main(): i32 {
  const decoder = new Decoder({ value: 42 });
  const decoded = attempt decoder.decode(false);
  return match (decoded) {
    success(value) => value - 42;
    failure(_) => 1;
  };
}
