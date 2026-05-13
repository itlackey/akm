# SOLID: Liskov Substitution Principle (LSP)

Subtypes must be substitutable for their base types.

## Definition

Objects of a derived class should be usable wherever base class objects are used, without the caller knowing the difference. The derived class must fulfill the contract of the base.

**Test**: If S is a subtype of T, objects of type T should be replaceable with objects of type S without altering any desirable properties of the program.

---

## Detection

**Flag** if:
- Subclass throws different exceptions than parent
- Subclass has weaker preconditions than parent
- Subclass has stronger postconditions than parent
- Subclass returns different types for same method
- Instance of subclass fails in a context where parent would work

---

## Examples

### BAD: Violating Liskov

```typescript
class Bird {
  fly(): void { /* ... */ }
}

class Penguin extends Bird {
  // Problem: Penguin can't fly but inherits fly()!
  fly(): void {
    throw new Error("Penguins can't fly!");
  }
}

// Client code
function letBirdFly(bird: Bird) {
  bird.fly();  // Works with Bird, breaks with Penguin!
}

letBirdFly(new Penguin());  // Runtime error
```

### GOOD: Proper Substitution

```typescript
abstract class Bird {
  abstract move(): void;
}

class Sparrow extends Bird {
  move(): void { this.fly(); }
}

class Penguin extends Bird {
  move(): void { this.swim(); }
}

// Client works with any Bird - substitution preserved
function migrate(birds: Bird[]) {
  birds.forEach(bird => bird.move());
}
```

---

## Forms of LSP Violation

### 1. Weaker Preconditions
```typescript
// Base class
class PaymentProcessor {
  process(amount: number): void {
    if (amount <= 0) throw Error("Invalid amount");
    // ...
  }
}

// Derived - LOWER constraint (allows more)
class FlexiblePayment extends PaymentProcessor {
  process(amount: number): void {
    // Now accepts negative! Client may not expect this.
    // Violation: accepts what parent rejected
  }
}
```

### 2. Stronger Postconditions
```typescript
// Base class
class Repository {
  find(id: string): Entity | null {
    // Can return null
    return this.cache.get(id);
  }
}

// Derived - STRICTER guarantee
class StrictRepository extends Repository {
  find(id: string): Entity {
    // Never returns null - but client might check for null!
    return this.cache.get(id) ?? throw new Error("Not found");
  }
}
```

### 3. Different Exception Types
```typescript
class FileLoader {
  load(path: string): Data {
    if (!exists(path)) throw new FileNotFoundException();
    // ...
  }
}

class NetworkLoader extends FileLoader {
  load(path: string): Data {
    if (!exists(path)) throw new Error("Not found");  // Different type!
    // ...
  }
}
```

---

## Remediation

1. Don't change what methods do in ways callers don't expect
2. If subclass can't fully implement parent, don't extend - create new interface
3. Use composition over inheritance when behavior differs significantly
4. Design by contract: maintain or strengthen postconditions, don't weaken preconditions