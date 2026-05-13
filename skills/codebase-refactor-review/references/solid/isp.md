# SOLID: Interface Segregation Principle (ISP)

No client should be forced to depend on methods it doesn't use.

## Definition

Large interfaces are problematic because classes that implement them are forced to provide implementations for all methods, even unused ones. Better to have many small, focused interfaces than one large one.

**Think**: Clients should only see methods relevant to their needs.

---

## Detection

**Flag** if:
- Interface has >8 methods
- Classes implement interfaces with many unused methods
- "Fat" interfaces with methods for multiple use cases
- Empty method implementations: `throw new NotImplementedException()`

**Check**: What methods does each client actually use?

---

## Examples

### BAD: Fat Interface

```typescript
// One large interface for all "worker" capabilities
interface Worker {
  work(): void;
  eat(): void;
  sleep(): void;
  commute(): void;
  code(): void;
  test(): void;
  document(): void;
  meeting(): void;
  plan(): void;
}

// Robot doesn't need most of these!
class Robot implements Worker {
  work(): void { /* ... */ }
  eat(): void { /* Robot doesn't eat - what to put here? */ }
  sleep(): void { /* Robot doesn't sleep */ }
  commute(): void { /* Not applicable */ }
  // ... all these are meaningless for Robot
}

// HumanWorker needs some but not all
class HumanWorker implements Worker {
  work(): void { /* ... */ }
  eat(): void { /* ... */ }
  // sleep, commute, code, test, etc. - may not all apply
}
```

### GOOD: Segregated Interfaces

```typescript
// Focused, minimal interfaces
interface Workable {
  work(): void;
}

interface Eatable {
  eat(): void;
}

interface Coder {
  code(): void;
}

interface Testable {
  test(): void;
}

// Robot only implements what it can do
class Robot implements Workable, Coder {
  work(): void { /* ... */ }
  code(): void { /* ... */ }
}

// Human implements multiple interfaces as needed
class HumanWorker implements Workable, Eatable, Coder, Testable {
  work(): void { /* ... */ }
  eat(): void { /* ... */ }
  code(): void { /* ... */ }
  test(): void { /* ... */ }
}
```

---

## Why It Matters

| Problem with Fat Interface | Benefit of Segregation |
|---|---|
| Unused methods create coupling | Clients depend only on what they use |
| Changes to unused methods affect all implementers | Changes only affect relevant clients |
| Empty method implementations | No dead code |
| Hard to understand what a class does | Clear, focused responsibilities |

---

## When ISP Conflicts with Other Principles

- **OCP**: Adding new behavior may require adding methods to interfaces
- **DIP**: Abstractions may need to combine multiple interfaces

**Solution**: Compose interfaces at the client level rather than at definition.

---

## Remediation

1. Identify which methods each client actually uses
2. Extract those into focused interfaces
3. Clients declare only the interfaces they need
4. Classes implement only interfaces relevant to them
5. Avoid "one interface to rule them all"