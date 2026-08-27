class EarlierHandle {
  owner: Weak<LaterOwner>;
}

class LaterOwner {
  id: i32;
}

function main(): i32 {
  const owner = new LaterOwner({ id: 42 });
  const handle = new EarlierHandle({ owner: weak owner });
  const upgraded = attempt handle.owner.upgrade();
  return match (upgraded) {
    success(current) => current.id - 42;
    failure(_) => 1;
  };
}
