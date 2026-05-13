# SOLID: Open/Closed Principle (OCP)

Software entities should be open for extension, closed for modification.

## Definition

You should be able to add new behavior without changing existing code. The system should allow extension through new code, not modification of existing code.

**Key insight**: Instead of changing a class when requirements change, extend it.

---

## Detection

**Flag** if:
- Adding features requires modifying existing classes
- Switch statements must be updated for new types
- Client code must change when you add new product types
- One change propagates to many places

**How to check**: When a new requirement arrives, what code must you change?

---

## Examples

### BAD: Open for Modification

```typescript
// Every new shape requires changing this function
function calculateArea(shape: Shape): number {
  switch (shape.type) {
    case 'circle':
      return Math.PI * shape.radius ** 2;
    case 'rectangle':
      return shape.width * shape.height;
    case 'triangle':
      return 0.5 * shape.base * shape.height;
    // Adding 'pentagon' requires MODIFYING this function
    default:
      throw new Error('Unknown shape');
  }
}
```

### GOOD: Open for Extension

```typescript
// New shapes just implement the interface - no changes to existing code
interface Shape {
  calculateArea(): number;
}

class Circle implements Shape {
  constructor(private radius: number) {}
  calculateArea(): number { return Math.PI * this.radius ** 2; }
}

class Rectangle implements Shape {
  constructor(private width: number, private height: number) {}
  calculateArea(): number { return this.width * this.height; }
}

// Adding new shapes doesn't touch this function
function calculateTotalArea(shapes: Shape[]): number {
  return shapes.reduce((sum, shape) => sum + shape.calculateArea(), 0);
}
```

---

## Mechanisms for OCP

| Mechanism | Use When |
|---|---|
| Strategy Pattern | Behavior varies by type |
| Template Method | Algorithm skeleton with varying steps |
| Decorator | Adding behavior dynamically |
| Inheritance/Composition | Extending base functionality |
| Plugin Architecture | System supports extensions |

---

## Violations

| Code Smell | What It Means |
|---|---|
| Switch on type | Need to add case for new type |
| Type-checking with instanceof | Need to add condition for new type |
| Deep if/else chain | New condition requires modifying chain |
| "Just add to the if" | Function grows with requirements |

---

## When OCP Doesn't Apply

- Prototype/small projects where change is cheap
- Performance-critical code where abstraction overhead matters
- One-off utility functions

---

## Remediation

1. Identify the changing part (e.g., shape types)
2. Create abstraction (interface, base class)
3. Move variant behavior to implementations
4. Client code depends on abstraction, not concrete
5. New types add new classes, not modify existing