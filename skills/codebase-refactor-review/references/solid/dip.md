# SOLID: Dependency Inversion Principle (DIP)

High-level modules should not depend on low-level modules. Both should depend on abstractions.

## Definition

1. High-level modules should not depend on low-level modules
2. Both should depend on abstractions
3. Abstractions should not depend on details, details should depend on abstractions

**Core idea**: Don't depend on concrete implementations; depend on interfaces/abstractions instead.

---

## Detection

**Flag** if:
- High-level business logic directly instantiates low-level classes
- `new` keyword appears in service/domain layer
- Changing database requires changing business logic
- Direct imports of concrete implementations in domain code

**Look for**: Dependencies flow from business logic to infrastructure, not the other way.

---

## Examples

### BAD: Direct Dependency

```typescript
// High-level module depends on low-level
class OrderService {
  private db = new MySQLDatabase();  // Direct instantiation!
  private email = new SendGridClient();  // Direct instantiation!
  private logger = new FileLogger();  // Direct instantiation!
  
  async createOrder(order: OrderData): Promise<Order> {
    this.logger.info('Creating order');
    const saved = await this.db.save(order);
    await this.email.send('order@example.com', 'Order created');
    return saved;
  }
}

// Problem: To test, must use real MySQL, SendGrid, FileLogger
// Problem: Changing database requires changing OrderService
// Problem: Can't swap implementations
```

### GOOD: Depend on Abstractions

```typescript
// Define abstractions (interfaces) in high-level module
interface OrderRepository {
  save(order: Order): Promise<Order>;
}

interface NotificationService {
  send(to: string, message: string): Promise<void>;
}

interface Logger {
  info(message: string): void;
}

// High-level module depends on abstractions
class OrderService {
  constructor(
    private repo: OrderRepository,
    private notifier: NotificationService,
    private logger: Logger
  ) {}
  
  async createOrder(order: OrderData): Promise<Order> {
    this.logger.info('Creating order');
    const saved = await this.repo.save(order);
    await this.notifier.send('order@example.com', 'Order created');
    return saved;
  }
}

// Low-level modules implement abstractions
class MySQLOrderRepository implements OrderRepository { ... }
class SendGridNotifier implements NotificationService { ... }
class ConsoleLogger implements Logger { ... }
```

---

## Dependency Flow

```
                    BAD (Direct)              GOOD (Inverted)
                    ───────────               ────────────────
                    
High-level    ──────► Low-level         High-level ◄──────► Low-level
(Business)         (Infrastructure)    (Business)        (Infrastructure)

Policy        ──────► Mechanism         Policy ◄─────────► Mechanism

Domain        ──────► Data Access       Domain ◄──────────► Data Access


```

---

## Implementation Patterns

### 1. Dependency Injection
```typescript
// Dependencies injected via constructor
class OrderService {
  constructor(private repo: OrderRepository) {}
}
```

### 2. DI Container
```typescript
// Container creates and injects dependencies
const container = new Container();
container.register('OrderRepository', MySQLOrderRepository);
const service = container.resolve(OrderService);
```

### 3. Factory with DI
```typescript
// Factory creates with injected dependencies
class ServiceFactory {
  createOrderService(): OrderService {
    return new OrderService(
      this.createRepository(),
      this.createNotifier()
    );
  }
}
```

---

## Violations

| Violation | Symptom |
|---|---|
| `new` in domain layer | Hard to test, tightly coupled |
| Concrete dependencies in constructor | Can't swap implementations |
| Infrastructure imported in domain | Changing DB affects business logic |

---

## When DIP is Difficult

- **Simple applications**: Overhead may not be worth it
- **Performance-critical code**: Abstraction has cost
- **Legacy code**: Refactoring may be risky

---

## Remediation

1. Identify where high-level code depends on low-level code
2. Extract interface from low-level (or define interface in high-level)
3. High-level depends on interface, not concrete
4. Inject implementations via constructor or container
5. Configure which implementations to use at startup