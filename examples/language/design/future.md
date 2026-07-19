# Future imported async flow

This is a design sketch, not a supported bootstrap program. `users.h` is
hypothetical: the example records the intended experience once callback-to-async
foreign synthesis and its imported user/error types exist.

```z
import users from "users.h";

async function showUser(id: UserId): void throws UserError {
  match (attempt await users.getUser(id)) {
    success(user) => show(user);
    failure(error) => showError(error);
  }
}
```
