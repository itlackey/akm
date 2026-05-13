# Anti-Patterns: Structural

Detailed reference for structural anti-patterns detection and remediation.

## 1. God Object

**Definition**: A class or module that has too many responsibilities, violating the Single Responsibility Principle.

**Detection**:
- Class has >5 distinct reasons to change
- Methods handle diverse concerns (data access, business logic, UI, logging, validation)
- File is a "catch-all" for miscellaneous functionality
- Difficulty explaining what the class does in one sentence

**Example**:
```typescript
// BAD: God Object - does everything
class UserManager {
  constructor(private db: Database, private logger: Logger) {}
  
  async createUser(data: CreateUserDTO): Promise<User> {
    // Validation
    // Database insert
    // Send welcome email
    // Log to analytics
    // Update cache
    // Trigger onboarding workflow
  }
  
  async generateReport(format: string): Promise<Buffer> {
    // Fetch data
    // Transform to format
    // Generate PDF/CSV
    // Upload to S3
    // Send notification
  }
  
  // 50 more methods...
}
```

**Remediation**: Extract into focused classes: UserRepository, EmailService, AnalyticsService, ReportGenerator, etc.

---

## 2. Spaghetti Code

**Definition**: Code with tangled, unstructured control flow that's difficult to follow and maintain.

**Detection**:
- Deeply nested conditionals (>4 levels)
- Goto statements or labeled loops
- Multiple exit points from functions
- Unpredictable execution paths
- Circular dependencies between functions

**Example**:
```python
# BAD: Spaghetti code
def process_order(order):
    if order.status == 'pending':
        if order.payment:
            if order.payment.status == 'approved':
                for item in order.items:
                    if item.in_stock:
                        if item.quantity <= item.available:
                            # actually do something
                            pass
                        else:
                            continue
                    else:
                        continue
                # ... 200 more lines
```

**Remediation**: Flatten logic with guard clauses, extract methods, use early returns, apply design patterns.

---

## 3. Copy-Paste Programming

**Definition**: Duplicated code blocks that should be extracted into shared functions or classes.

**Detection**:
- >10 identical lines across files
- Similar logic with minor variations repeated
- Copy-paste with "just change this one thing"
- Search for identical function bodies

**Example**:
```javascript
// BAD: Duplicated validation logic
function createUser(data) {
  if (!data.email || !data.email.includes('@')) {
    throw new Error('Invalid email');
  }
  if (!data.name || data.name.length < 2) {
    throw new Error('Invalid name');
  }
  // ... save user
}

function updateUser(id, data) {
  if (!data.email || !data.email.includes('@')) {
    throw new Error('Invalid email');
  }
  if (!data.name || data.name.length < 2) {
    throw new Error('Invalid name');
  }
  // ... update user
}
```

**Remediation**: Extract to shared validation function, create validation library, use inheritance or composition.

---

## 4. Shotgun Surgery

**Definition**: A single logical change requires modifications in many different locations.

**Detection**:
- Changing a field name requires 5+ file edits
- Adding a feature touches unrelated files
- Similar changes repeated across codebase
- "When I change X, I always have to change Y, Z, and A too"

**Example**:
```go
// BAD: Same field added to multiple structs
type User struct {
    ID        string
    Name      string
    Email     string
    CreatedAt time.Time
    // Need to add 'TenantID' - must update ALL of these:
}

type Order struct { TenantID string }
type Product struct { TenantID string }
type Invoice struct { TenantID string }
// ... 20 more types
```

**Remediation**: Introduce shared type/interface, use composition, centralize common fields.

---

## 5. Feature Envy

**Definition**: A method is more interested in another class's data than its own.

**Detection**:
- Method accesses >3 other objects' fields/methods more than its own
- Gets and sets on another object dominate the method
- Logic operates on data that belongs elsewhere

**Example**:
```java
// BAD: Feature envy - OrderCalc envies Customer
class OrderCalculator {
    public double calculateDiscount(Order order) {
        // More interested in Customer than Order
        Customer c = order.getCustomer();
        
        if (c.getType().equals("VIP") && 
            c.getTotalOrders() > 10 &&
            c.getAverageRating() > 4.5 &&
            c.getDaysSinceLastOrder() < 30) {
            return 0.20;
        }
        // ...
    }
}
```

**Remediation**: Move method to the class it envies, or extract the logic into a domain service.

---

## 6. Inappropriate Intimacy

**Definition**: Two classes are too tightly coupled through direct access to each other's internals.

**Detection**:
- Class reads another class's private fields
- One class depends on another's internal representation
- Circular dependencies between modules
- Refactoring one breaks the other

**Example**:
```typescript
// BAD: Inappropriate intimacy
class Order {
  private items: LineItem[];
  private status: OrderStatus;
  
  // Other class directly accesses internals
}

class OrderProcessor {
  process(order: Order) {
    // Directly manipulating internal state
    for (let item of order['items']) {  // Accessing private via bracket
      item.quantity = item.quantity || 0;  // Modifying internal
    }
    order.status = 'processed';  // Bypassing setter logic
  }
}
```

**Remediation**: Use encapsulation, introduce interfaces, create communication channels.

---

## 7. Primitive Obsession

**Definition**: Using primitive types (strings, numbers) instead of meaningful domain types.

**Detection**:
- Parameters are raw strings/numbers without validation
- Business logic operates on primitives not domain types
- Multiple parameters of same primitive type (e.g., 3 strings)
- Validation logic repeated across functions

**Example**:
```typescript
// BAD: Primitive obsession
function createUser(
  name: string,      // What if name is empty?
  email: string,    // Is this validated?
  phone: string,    // Format?
  age: number       // Is this validated?
) { ... }

// Usage
createUser("John", "john@email", "555-1234", 25);
createUser("", "invalid", "unknown", -5);  // Compiles but wrong
```

**Remediation**: Create domain types (Email, PhoneNumber, Age, UserName) with validation in constructors.

---

## 8. Data Clumps

**Definition**: Groups of parameters or fields that always appear together and should be a single abstraction.

**Detection**:
- 3+ parameters frequently passed together
- Same group of fields repeated across multiple classes
- Methods have overlapping parameter sets

**Example**:
```csharp
// BAD: Data clumps - coordinates always together
void DrawCircle(x, y, radius, color, strokeWidth);
void MoveShape(x, y, color, strokeWidth);
void ScaleObject(x, y, factor, color, strokeWidth);
// x, y, color, strokeWidth always together

// Should be:
class Point { x: number; y: number; }
class Style { color: string; strokeWidth: number; }
void DrawCircle(Point point, double radius, Style style);
```

**Remediation**: Create a class or struct for the clump, use it consistently.

---

## 9. Switch/Case Abuse

**Definition**: Large switch statements that should be handled via polymorphism or a table-driven approach.

**Detection**:
- Switch with >4 cases based on type or enum
- Adding new type requires modifying switch
- Cases duplicate behavior that could be in type implementations
- Default case contains "other" handling

**Example**:
```python
# BAD: Switch abuse
def calculate_shipping(order):
    if order.country == 'US':
        return order.weight * 0.5 + 5
    elif order.country == 'CA':
        return order.weight * 0.7 + 8
    elif order.country == 'UK':
        return order.weight * 0.9 + 12
    elif order.country == 'DE':
        return order.weight * 0.8 + 10
    # ... 20 more countries
    else:
        return order.weight * 1.0 + 15
```

**Remediation**: Use strategy pattern, registry, or table-driven approach.

---

## 10. Dead Code

**Definition**: Unused code that remains in the codebase and increases maintenance burden.

**Detection**:
- Unused variables, functions, classes, imports
- Unreachable code after return/throw
- Commented-out code blocks
- Features marked as "deprecated" but not removed

**Example**:
```javascript
// BAD: Dead code
import { unusedFunction } from './utils';  // Never used

const deprecatedConfig = {  // Referenced nowhere
  oldSetting: true,
  legacyOption: 'value'
};

function calculateTotal(items) {
  // return items.reduce(...) // Commented out, what?
  return 0;
}
```

**Remediation**: Use linter to detect, remove unused code, delete commented blocks, deprecate properly.

---

## 11. Lazy Class

**Definition**: A class with too few responsibilities that doesn't justify its existence.

**Detection**:
- Class with <100 lines total
- <3 public methods
- Class does almost nothing
- Only exists to satisfy some framework requirement

**Example**:
```python
# BAD: Lazy class
class OrderValidator:
    def validate(self, order):
        return True  # Does nothing

# Usage
validator = OrderValidator()
validator.validate(order)  # Why not just True?
```

**Remediation**: Inline into caller, merge with related class, or delete if truly unnecessary.

---

## 12. Speculative Generality

**Definition**: Abstractions created for potential future use that never materialize.

**Detection**:
- "Just in case" interfaces with one implementation
- Abstract classes with one subclass
- Generics/parameters for flexibility never used
- "We might need this" comments

**Example**:
```java
// BAD: Speculative generality
public interface Repository<T> {
    T findById(String id);
    List<T> findAll();
    void save(T entity);
    void delete(String id);
}

// Only used for User, but created generic
public class UserRepository implements Repository<User> {
    // ... implements all methods
}

// All other types use direct JDBC or nothing
```

**Remediation**: YAGNI - don't build abstractions until you have 2+ use cases.