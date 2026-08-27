import { Array } from "std/collections";

export struct Builder {
  values: Array<i32>;
}

function createBuilder(): Builder {
  return Builder({ values: Array<i32>() });
}

export struct Application {
  name: String = "Defaults";
  builder: Builder = createBuilder();
}
