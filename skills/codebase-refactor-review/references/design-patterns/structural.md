# Design Patterns: Structural

When and how to apply structural patterns.

## Adapter

**Intent**: Convert the interface of a class into another interface that clients expect.

**When to Apply**:
- Integrating with external systems with different interfaces
- Working with legacy code with incompatible interface
- Creating reusable classes that cooperate with unrelated classes

**Red Flag**: Direct usage of external library types throughout codebase.

```typescript
// Before: External library used directly
import Stripe from 'stripe';
const stripe = new Stripe('key');
const charge = await stripe.charges.create({ amount: 100, currency: 'usd' });

// After: Adapter hides external interface
interface PaymentGateway {
  charge(amount: number, currency: string): Promise<ChargeResult>;
}

class StripeAdapter implements PaymentGateway {
  private stripe: Stripe;
  
  async charge(amount: number, currency: string): Promise<ChargeResult> {
    const result = await this.stripe.charges.create({ amount, currency });
    return { id: result.id, status: result.status };
  }
}

// Now client uses interface, not Stripe directly
class OrderService {
  constructor(private gateway: PaymentGateway) {}
}
```

---

## Decorator

**Intent**: Attach additional responsibilities to an object dynamically.

**When to Apply**:
- Adding behavior without modifying class
- Responsibilities can be added/removed at runtime
- Inheritance would create too many combinations

**Red Flag**: Inheritance chains for adding behavior.

```typescript
// Before: Inheritance explosion
class Coffee { cost() { return 5; } }
class CoffeeWithMilk extends Coffee { cost() { return 6; } }
class CoffeeWithSugar extends Coffee { cost() { return 5.5; } }
class CoffeeWithMilkAndSugar extends Coffee { cost() { return 6.5; } }
// N combinations for N add-ons!

// After: Decorators
interface Coffee {
  cost(): number;
}

class SimpleCoffee implements Coffee {
  cost() { return 5; }
}

class MilkDecorator implements Coffee {
  constructor(private coffee: Coffee) {}
  cost() { return this.coffee.cost() + 1; }
}

class SugarDecorator implements Coffee {
  constructor(private coffee: Coffee) {}
  cost() { return this.coffee.cost() + 0.5; }
}

// Composable at runtime
const coffee = new SugarDecorator(new MilkDecorator(new SimpleCoffee()));
```

---

## Facade

**Intent**: Provide a unified interface to a set of interfaces in a subsystem.

**When to Apply**:
- Complex subsystem with many classes
- You want to provide simple interface to a complex system
- Layer subsystem with facades

**Red Flag**: Clients directly construct/use many subsystem classes.

```typescript
// Before: Complex subsystem
const connection = new DatabaseConnection(host, port);
const queryBuilder = new QueryBuilder(connection);
const cache = new CacheManager();
const auth = new AuthProvider();

// Client must know all these
const user = await auth.verify(token);
const data = await queryBuilder.select('users').where({ id: user.id }).execute();
cache.set(`user:${user.id}`, data);

// After: Facade
class UserServiceFacade {
  async getUser(token: string): Promise<User> {
    // Hides all complexity
  }
}

// Client uses simple interface
const userService = new UserServiceFacade();
const user = await userService.getUser(token);
```

---

## Composite

**Intent**: Compose objects into tree structures to represent part-whole hierarchies.

**When to Apply**:
- Part-whole hierarchy (organization, UI, file system)
- Clients should treat individual and composite objects uniformly
- Tree structures where parents have children of same type

**Red Flag**: Recursive structures handled with special cases.

```typescript
interface FileSystemItem {
  getSize(): number;
  getName(): string;
}

class File implements FileSystemItem {
  constructor(private name: string, private size: number) {}
  getSize() { return this.size; }
  getName() { return this.name; }
}

class Folder implements FileSystemItem {
  private items: FileSystemItem[] = [];
  add(item: FileSystemItem) { this.items.push(item); }
  
  getSize() { return this.items.reduce((sum, item) => sum + item.getSize(), 0); }
  getName() { return 'folder'; }
}

// Uniform treatment - client doesn't check type
function getTotalSize(items: FileSystemItem[]): number {
  return items.reduce((sum, item) => sum + item.getSize(), 0);
}
```

---

## Proxy

**Intent**: Provide a surrogate or placeholder for another object to control access to it.

**When to Apply**:
- Lazy initialization (virtual proxy)
- Access control (protection proxy)
- Local execution of remote service (remote proxy)
- Logging and caching (smart reference)

**Red Flag**: Manual resource management code mixed with business logic.

---

## Summary Table

| Pattern | Use When | Red Flag |
|---|---|---|
| Adapter | Interface mismatch | Direct external lib usage |
| Decorator | Add behavior dynamically | Inheritance for behavior |
| Facade | Simplify complex subsystem | Client knows subsystem details |
| Composite | Part-whole hierarchy | Type checking in tree traversal |
| Proxy | Control access to object | Manual resource management |