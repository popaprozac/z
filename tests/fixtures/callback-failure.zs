import native from "callback-failure.h";

struct VisitError {
  message: String;
}

function main(): i32 {
  const visitor: (row: i32) => i32 throws VisitError =
    (row: i32): i32 throws VisitError => {
      if (row == 2) {
        throw VisitError({ message: "stop visiting rows" });
      }
      return 0;
    };
  const result = attempt native.z_visit_rows(visitor);

  return match (result) {
    success => 1;
    failure(_) => 0;
  };
}
