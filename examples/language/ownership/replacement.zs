import stdio from "stdio.h";

struct Resource {
  id: i32;

  function bumped(move this, amount: i32): Resource {
    this.id = this.id + amount;
    return this;
  }

  deinit {
    stdio.printf("drop=%d\n", this.id);
  }
}

struct Holder {
  resource: Resource;
}

function make(id: i32): Resource {
  stdio.printf("make=%d\n", id);
  return Resource({ id: id });
}

function main(): i32 {
  let resource = Resource({ id: 1 });
  resource = make(2);
  resource = resource.bumped(3);
  stdio.printf("live=%d\n", resource.id);

  let holder = Holder({ resource: Resource({ id: 10 }) });
  let incoming = Resource({ id: 20 });
  holder.resource = incoming;
  stdio.printf("holder=%d\n", holder.resource.id);
  return 0;
}
