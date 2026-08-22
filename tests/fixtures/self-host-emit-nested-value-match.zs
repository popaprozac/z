enum InnerValue {
  some i32,
  none,
}

enum OuterValue {
  success InnerValue,
  failure String,
}

function nested(in value: OuterValue): i32 {
  return match (value) {
    success(inner) => {
      select match (inner) {
        some(answer) => answer;
        none => 0;
      };
    }
    failure(_) => -1;
  };
}

function main(): i32 {
  const maximum: u64 = 18446744073709551615;
  if (maximum != 18446744073709551615) return 1;
  const value = OuterValue.success(InnerValue.some(42));
  return nested(in value) - 42;
}
