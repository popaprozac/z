// The record and its maker that call-field-default.zs names in its field
// defaults, and an exported struct whose own default calls a function of
// this module.
export struct Record {
  names: Array<u32>;
}

export function emptyRecord(): Record {
  let names = Array<u32>();
  names.push(1);
  return Record({ names: names });
}

function startCount(): u32 {
  return 3;
}

export struct Tally {
  id: u32;
  count: u32 = startCount();
  record: Record = emptyRecord();
}
