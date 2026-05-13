# Anti-Patterns: Creational

Detailed reference for creational anti-patterns detection and remediation.

## 1. Raw Constructor Overuse

**Definition**: Constructors with too many parameters, making them difficult to use correctly.

**Detection**:
- Constructor has >4 parameters
- Parameters of same type (which is which?)
- Optional parameters represented as nulls
- Constructor requires reading documentation to use

**Example**:
```typescript
// BAD: Too many constructor parameters
class UserService {
  constructor(
    db: Database,
    logger: Logger,
    cache: Cache,
    email: EmailService,
    analytics: Analytics,
    config: Config,
    auth: AuthService,
    crypto: CryptoService
  ) { ... }
}

// Calling it
new UserService(db, logger, cache, email, analytics, config, auth, crypto);
// Which parameter is which? Wrong order causes subtle bugs!
```

**Remediation**: Use Builder pattern, introduce parameter objects, use dependency injection container.

---

## 2. Hidden Dependencies

**Definition**: Dependencies are created inside methods/constructors instead of being injected.

**Detection**:
- `new` keyword inside business logic methods
- Static factory calls in constructors
- Global state accessed without DI
- Constructor creates its own dependencies

**Example**:
```typescript
// BAD: Hidden dependencies
class OrderService {
  createOrder(data: OrderData): Order {
    // Creating dependencies inside method
    const db = new Database();
    const logger = new Logger();
    const notifier = new EmailNotifier();
    
    // ... business logic
  }
}
```

**Remediation**: Inject dependencies via constructor or method parameters, use DI container.

---

## 3. Singleton Abuse

**Definition**: Overuse of singletons leading to hidden global state and tight coupling.

**Detection**:
- Global mutable state accessed throughout codebase
- Testing requires mocking singletons
- Can't create alternative implementations
- "There's only one of these" reasoning

**Example**:
```python
# BAD: Singleton abuse - global mutable state
class Database:
    _instance = None
    
    def __init__(self):
        if Database._instance:
            raise Exception("Use get_instance()")
    
    @staticmethod
    def get_instance():
        if not Database._instance:
            Database._instance = Database()
        return Database._instance

# Used everywhere - hidden dependency
def process_order(order_id):
    db = Database.get_instance()  # Where is this defined?
    # ...
```

**Remediation**: Inject dependencies, use factory for testability, consider immutable designs.

---

## 4. Missing Factory

**Definition**: Object creation logic is duplicated across multiple callers instead of centralized.

**Detection**:
- Same object construction repeated in >3 locations
- Subclass selection scattered across code
- Configuration logic duplicated
- "How do I create a X?" requires searching codebase

**Example**:
```typescript
// BAD: Missing factory - duplicated creation
// In user-service.ts
const user = new User({
  name: data.name,
  email: data.email,
  verified: false,
  createdAt: new Date(),
  role: 'user',
  settings: defaultSettings
});

// In admin-service.ts - almost identical!
const user = new User({
  name: data.name,
  email: data.email,
  verified: false,
  createdAt: new Date(),
  role: 'user',
  settings: defaultSettings
});

// In auth-service.ts - again!
const user = new User({ ... });
```

**Remediation**: Create factory class or function, centralize creation logic.

---

## 5. Missing Builder

**Definition**: Complex object construction done directly with constructors instead of builder pattern.

**Detection**:
- Constructor with many optional parameters
- Telescoping constructor anti-pattern (multiple constructors)
- Construction logic in multiple steps not captured
- Object creation requires understanding all parameters

**Example**:
```java
// BAD: Missing builder - telescoping constructor
class Email {
    private String to;
    private String from;
    private String subject;
    private String body;
    private Priority priority;
    private List<String> cc;
    private List<String> bcc;
    private boolean attachments;
    private String replyTo;
    
    public Email(String to) { ... }
    public Email(String to, String from) { ... }
    public Email(String to, String from, String subject) { ... }
    // 7 constructors!
}

// Usage - which constructor?
Email email = new Email("bob@example.com", "alice@example.com", 
    "Subject", "Body", Priority.HIGH, Arrays.asList("cc"), 
    Arrays.asList("bcc"), true, "reply@example.com");
```

**Remediation**: Implement Builder pattern or use factory with named parameters.