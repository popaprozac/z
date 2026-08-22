import json from "std/json";

function exactU64(in value: json.JsonValue): i32 {
  return match (in value) {
    number(number) => {
      const converted = attempt number.toU64();
      select match (converted) {
        success(integer) => integer == u64(18446744073709551615) ? 0 : 1;
        failure(_) => 2;
      };
    }
    nullValue => 3;
    boolean(_) => 3;
    string(_) => 3;
    array(_) => 3;
    object(_) => 3;
  };
}

function main(): i32 {
  const maximum = attempt json.parse("18446744073709551615");
  const checked = match (maximum) {
    success(value) => {
      if (json.stringify(in value) != "18446744073709551615") {
        return 4;
      }
      select exactU64(in value);
    }
    failure(_) => 5;
  };
  if (checked != 0) return checked;

  const arbitrary = attempt json.parse("123456789012345678901234567890.125e+9999");
  const forwarded = match (arbitrary) {
    success(value) => json.stringify(in value);
    failure(_) => "";
  };
  if (forwarded != "123456789012345678901234567890.125e+9999") return 6;

  const constructed = json.JsonValue.number(json.JsonNumber.fromU64(u64(42)));
  if (json.stringify(in constructed) != "42") return 7;

  const fraction = attempt json.JsonNumber.parse("1.5");
  return match (fraction) {
    success(number) => {
      const integer = attempt number.toI64();
      select match (integer) {
        success(_) => 8;
        failure(_) => 0;
      };
    }
    failure(_) => 9;
  };
}
