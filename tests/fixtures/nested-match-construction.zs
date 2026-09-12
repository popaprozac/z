import console from "std/console";

struct Receipt {
  label: String;
  deinit { console.log(this.label); }
}

enum Response {
  text String,
  empty,
}

struct Failure { message: String; }

function reject(): String throws Failure {
  const text = "rejected!";
  throw Failure({ message: text.copyBytes(0, 8) });
}

function fallible(option: Option<String>): Response throws Failure {
  return Response.text(match (option) {
    some(text) => {
      const result = try reject();
      console.log(text);
      select result;
    }
    none => "missing";
  });
}

function nested(option: Option<String>): Option<Response> {
  return Option<Response>.some(Response.text(match (option) {
    some(text) => { select text; }
    none => "missing";
  }));
}

function respond(option: Option<String>): Response {
  return Response.text(match (option) {
    some(text) => {
      const receipt = Receipt({ label: "released selected arm" });
      select text;
    }
    none => {
      const receipt = Receipt({ label: "released fallback arm" });
      select "missing";
    }
  });
}

function leaveEarly(option: Option<String>): Response {
  const outer = Receipt({ label: "released outer" });
  return Response.text(match (option) {
    some(text) => {
      const arm = Receipt({ label: "released early arm" });
      if (text.byteLength == 6) return Response.empty;
      select text;
    }
    none => "fallback";
  });
}

function borrowed(in option: Option<String>): Response {
  const response = Response.text(match (in option) {
    some(text) => { select text.copyBytes(0, text.byteLength); }
    none => "missing";
  });
  return response;
}

function main(): i32 {
  const source = "answer!";
  const first = respond(Option<String>.some(source.copyBytes(0, 6)));
  match (first) {
    text(value) => console.log(value);
    empty => return 1;
  }
  const second = respond(Option<String>.none);
  match (second) {
    text(value) => console.log(value);
    empty => return 2;
  }
  const early = leaveEarly(Option<String>.some(source.copyBytes(0, 6)));
  match (early) { empty => {} text(_) => return 3; }
  const input = Option<String>.some(source.copyBytes(0, 6));
  const copied = borrowed(in input);
  match (copied) { text(value) => console.log(value); empty => return 4; }
  match (in input) { some(value) => console.log(value); none => return 5; }
  const rejected = attempt fallible(Option<String>.some(source.copyBytes(0, 6)));
  match (rejected) { success(_) => return 6; failure(error) => console.log(error.message); }
  const wrapped = nested(Option<String>.some(source.copyBytes(0, 6)));
  match (wrapped) {
    some(response) => match (response) { text(value) => console.log(value); empty => return 7; }
    none => return 8;
  }
  return 0;
}
