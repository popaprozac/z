struct Resource {
  id: i32;

  deinit {}
}

struct Envelope {
  resource: Resource;
}

struct AuditedEnvelope {
  resource: Resource;

  deinit {
    const audit: Resource = Resource({ id: this.resource.id });
    record(audit.id);
  }
}

function record(id: i32): void {
  if (id < 0) return;
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

function loopLocal(limit: i32): i32 {
  let index: i32 = 0;
  let observed: i32 = 0;
  while (index < limit) {
    const resource: Resource = Resource({ id: index + 10 });
    index = index + 1;
    if (index == 1) {
      continue;
    }
    observed = observed + resource.id;
    if (index == 3) {
      break;
    }
  }
  return observed;
}

function replaceOwner(next: i32, replace: boolean): i32 {
  let resource: Resource = Resource({ id: 4 });
  if (replace) {
    resource = Resource({ id: resource.id + next });
  }
  return resource.id;
}

function nestedCleanup(): i32 {
  const envelope: Envelope = Envelope({
    resource: Resource({ id: 42 }),
  });
  return envelope.resource.id;
}

function customCleanup(): i32 {
  const envelope: AuditedEnvelope = AuditedEnvelope({
    resource: Resource({ id: 42 }),
  });
  return envelope.resource.id;
}

function main(): i32 {
  return inspectBranch(Resource({ id: 5 }), true)
    + inspectLoop(Resource({ id: 7 }), 3)
    + localBranch(false)
    + branchLocal(true)
    + earlyBranch(true)
    + loopLocal(5)
    - 23
    + replaceOwner(5, true)
    - 9
    + nestedCleanup()
    - 42
    + customCleanup()
    - 42
    - 1;
}
