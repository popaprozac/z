// Raw native source is an explicit last-resort boundary. Prefer a header import
// plus an adjacent .zd contract whenever the API can be described safely.

function add(left: i32, right: i32): i32 = raw c {
  return left + right;
}

function main(): i32 {
  const left: i32 = 20;
  let right: i32 = 2;
  let output: i32;

  const observed = raw c
    using (in left, inout right, out output)
    : i32 {
      *right += *left;
      *output = *right;
      return *output;
    };
  const label: cstring = "raw";
  const labelStatus = raw c using (in label): i32 {
    return label[0] == 'r' ? 0 : 1;
  };

  return add(observed, 20) - 42 + labelStatus;
}
