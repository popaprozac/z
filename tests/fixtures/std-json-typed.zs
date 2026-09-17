import json from "std/json";

struct User {
  id: u64;
  name: String;
  active: boolean = true;
  role: String = "guest";
  tags: Array<String>;
}

function verify(in user: User): i32 throws json.JsonEncodeError {
  if (user.id != 18446744073709551615) return 1;
  if (user.name != "Ada") return 2;
  if (!user.active) return 3;
  if (user.role != "admin") return 10;
  if (user.tags.length != 2) return 12;
  if (user.tags[0] != "compiler" || user.tags[1] != "native") return 13;
  const encoded = try json.encode(in user);
  if (encoded != '{"id":18446744073709551615,"name":"Ada","active":true,"role":"admin","tags":["compiler","native"]}') return 4;
  return 0;
}

function rejects(in source: String): boolean {
  const decoded = attempt json.decode<User>(in source);
  return match (decoded) {
    success(_) => false;
    failure(_) => true;
  };
}

function main(): i32 {
  return match (attempt run()) {
    success(status) => status;
    failure(_) => 99;
  };
}

function run(): i32 throws json.JsonEncodeError {
  const decoded = attempt json.decode<User>(
    '{"id":18446744073709551615,"name":"Ada","role":"admin","tags":["compiler","native"],"ignored":{"nested":[1,true,null]}}'
  );
  const verified = match (decoded) {
    success(user) => {
      const encoded = try json.encode(in user);
      if (encoded != '{"id":18446744073709551615,"name":"Ada","active":true,"role":"admin","tags":["compiler","native"]}') {
        return 11;
      }
      select try verify(in user);
    }
    failure(_) => 5;
  };
  if (verified != 0) return verified;
  if (!rejects('{"name":"Ada"}')) return 6;
  if (!rejects('{"id":1,"id":2,"name":"Ada"}')) return 7;
  if (!rejects('{"id":18446744073709551616,"name":"Ada"}')) return 8;
  if (!rejects('{"id":1,"name":"Ada","active":0}')) return 9;
  return 0;
}
