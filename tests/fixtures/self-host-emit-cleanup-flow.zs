struct Resource {
  id: i32;

  deinit {}
}

function inspectBranch(resource: Resource, chooseFirst: boolean): i32 {
  if (chooseFirst) {
    return resource.id;
  }
  return resource.id + 1;
}

function inspectLoop(resource: Resource, limit: i32): i32 {
  let index: i32 = 0;
  while (index < limit) {
    if (index == 2) {
      return resource.id + index;
    }
    index = index + 1;
  }
  return resource.id;
}

function localBranch(chooseFirst: boolean): i32 {
  const resource: Resource = Resource({ id: 20 });
  if (chooseFirst) {
    return resource.id;
  }
  return resource.id + 2;
}

function main(): i32 {
  return inspectBranch(Resource({ id: 5 }), true)
    + inspectLoop(Resource({ id: 7 }), 3)
    + localBranch(false)
    + 6;
}
