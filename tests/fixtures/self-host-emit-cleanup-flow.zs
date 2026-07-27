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

function branchLocal(chooseFirst: boolean): i32 {
  let observed: i32 = 0;
  if (chooseFirst) {
    const branch: Resource = Resource({ id: 3 });
    observed = branch.id;
  } else {
    const alternate: Resource = Resource({ id: 30 });
    observed = alternate.id;
  }
  return observed;
}

function earlyBranch(chooseFirst: boolean): i32 {
  if (chooseFirst) {
    const branch: Resource = Resource({ id: 4 });
    return branch.id;
  }
  return 0;
}

function main(): i32 {
  return inspectBranch(Resource({ id: 5 }), true)
    + inspectLoop(Resource({ id: 7 }), 3)
    + localBranch(false)
    + branchLocal(true)
    + earlyBranch(true)
    - 1;
}
