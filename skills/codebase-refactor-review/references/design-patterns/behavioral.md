# Design Patterns: Behavioral

When and how to apply behavioral patterns.

## Strategy

**Intent**: Define a family of algorithms, encapsulate each one, and make them interchangeable.

**When to Apply**:
- Multiple algorithms for same task
- You need to select algorithm at runtime
- Conditional logic to select behavior

**Red Flag**: Conditional logic (if/else or switch) to select behavior.

```typescript
// Before: Conditional selection
function calculateShipping(order: Order): number {
  if (order.weight < 5) return order.weight * 1.0;
  else if (order.weight < 20) return order.weight * 0.8;
  else return order.weight * 0.5;
}

// After: Strategy pattern
interface ShippingStrategy {
  calculate(order: Order): number;
}

class StandardShipping implements ShippingStrategy {
  calculate(order: Order): number { return order.weight * 1.0; }
}

class ExpressShipping implements ShippingStrategy {
  calculate(order: Order): number { return order.weight * 1.5 + 10; }
}

class FreeShipping implements ShippingStrategy {
  calculate(order: Order): number { return 0; }
}

// Usage
class ShippingCalculator {
  constructor(private strategy: ShippingStrategy) {}
  
  calculate(order: Order): number {
    return this.strategy.calculate(order);
  }
}
```

---

## Observer / Event Emitter

**Intent**: Define a one-to-many dependency between objects so when one changes state, all dependents are notified.

**When to Apply**:
- Changes in one object should update many others
- Event handling system needed
- Loose coupling between publisher and subscribers

**Red Flag**: Manual callback registration, list of listeners with notify methods.

```typescript
// Before: Manual callback management
class UserManager {
  private callbacks: Function[] = [];
  
  onUpdate(fn: Function) { this.callbacks.push(fn); }
  
  updateUser(user: User) {
    this.user = user;
    this.callbacks.forEach(fn => fn(user));  // Manual notification
  }
}

// After: Observer pattern
interface Observer<T> {
  update(data: T): void;
}

interface Subject<T> {
  subscribe(observer: Observer<T>): void;
  unsubscribe(observer: Observer<T>): void;
  notify(): void;
}

class UserSubject implements Subject<User> {
  private observers: Observer<User>[] = [];
  private state!: User;
  
  subscribe(observer: Observer<User>) {
    this.observers.push(observer);
  }
  
  notify() {
    this.observers.forEach(o => o.update(this.state));
  }
}
```

---

## Command

**Intent**: Encapsulate a request as an object, allowing parameterization, queuing, and undo.

**When to Apply**:
- Operations that should be undoable
- Operations to queue or log
- Parameterize objects with operations

**Red Flag**: Action methods called directly with parameters.

```typescript
// Before: Direct action
function deleteUser(id: string) {
  db.users.delete(id);
  logger.info(`Deleted ${id}`);
}

// After: Command pattern
interface Command {
  execute(): void;
  undo(): void;
}

class DeleteUserCommand implements Command {
  private user!: User;
  
  constructor(private id: string, private db: Database, private logger: Logger) {}
  
  execute() {
    this.user = this.db.users.get(this.id);
    this.db.users.delete(this.id);
    this.logger.info(`Deleted ${this.id}`);
  }
  
  undo() {
    this.db.users.insert(this.user);
    this.logger.info(`Restored ${this.id}`);
  }
}

// Commands can be queued, logged, undone
class CommandManager {
  private history: Command[] = [];
  
  execute(cmd: Command) {
    cmd.execute();
    this.history.push(cmd);
  }
  
  undo() {
    const cmd = this.history.pop();
    cmd?.undo();
  }
}
```

---

## State

**Intent**: Allow an object to alter its behavior when its internal state changes.

**When to Apply**:
- Object behavior depends on state
- Complex state machine with multiple states and transitions
- State-specific behavior in conditionals

**Red Flag**: Boolean/numeric flags controlling behavior (`if (status === 'pending')`).

```typescript
// Before: Flag-based behavior
class Order {
  status: string = 'pending';
  
  submit() {
    if (this.status === 'pending') {
      this.status = 'submitted';
      // ...
    }
  }
  
  cancel() {
    if (this.status === 'pending' || this.status === 'submitted') {
      this.status = 'cancelled';
      // ...
    }
  }
  // Bug: What about 'processing'? What if cancelled twice?
}

// After: State pattern
interface OrderState {
  submit(order: Order): void;
  cancel(order: Order): void;
}

class PendingState implements OrderState {
  submit(order: Order) { order.transitionTo(new SubmittedState()); }
  cancel(order: Order) { order.transitionTo(new CancelledState()); }
}

class SubmittedState implements OrderState {
  submit(order: Order) { /* already submitted */ }
  cancel(order: Order) { order.transitionTo(new CancelledState()); }
}

class Order {
  private state: OrderState = new PendingState();
  
  submit() { this.state.submit(this); }
  cancel() { this.state.cancel(this); }
  
  transitionTo(state: OrderState) { this.state = state; }
}
```

---

## Chain of Responsibility

**Intent**: Pass a request along a chain of handlers until one handles it.

**When to Apply**:
- Multiple handlers can process request
- Handler determined dynamically
- Decouple sender from receivers

**Red Flag**: Long if/else chain processing request.

```typescript
// Before: If/else chain
function handleRequest(req: Request): Response {
  if (auth(req)) {
    if (validate(req)) {
      if (process(req)) {
        return success();
      }
    }
  }
  return error();
}

// After: Chain of Responsibility
interface Handler {
  setNext(handler: Handler): Handler;
  handle(req: Request): Response | null;
}

class AuthHandler implements Handler {
  handle(req: Request): Response | null {
    if (!auth(req)) return unauthorized();
    return this.next?.handle(req);
  }
}

class ValidationHandler implements Handler {
  handle(req: Request): Response | null {
    if (!validate(req)) return badRequest();
    return this.next?.handle(req);
  }
}
```

---

## Iterator

**Intent**: Provide a way to access elements of a collection without exposing underlying representation.

**When to Apply**:
- Traverse collections uniformly
- Different collection types with same traversal
- Filter or transform during iteration

**Red Flag**: Manual index management in loops.

---

## Template Method

**Intent**: Define the skeleton of an algorithm in a method, deferring some steps to subclasses.

**When to Apply**:
- Algorithm with invariant steps
- Variation in some steps only
- Framework with extension points

**Red Flag**: Duplicated algorithm structure in multiple classes.

---

## Memento

**Intent**: Capture and externalize an object's state so it can be restored later.

**When to Apply**:
- Undo functionality needed
- Checkpoint/snapshot system
- State restore on failure

**Red Flag**: Manual field copying to save/restore state.

---

## Summary Table

| Pattern | Use When | Red Flag |
|---|---|---|
| Strategy | Select algorithm at runtime | if/else for behavior |
| Observer | One-to-many updates | Manual callback lists |
| Command | Undoable/queueable actions | Direct method calls |
| State | State-dependent behavior | Boolean flags |
| Chain | Sequential handlers | Long if/else chains |
| Iterator | Uniform traversal | Index manipulation |
| Template | Algorithm skeleton | Duplicated algorithms |
| Memento | State snapshots | Manual field copy |