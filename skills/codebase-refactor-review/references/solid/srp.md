# SOLID: Single Responsibility Principle (SRP)

Every module, class, or function should have one reason to change.

## Definition

A class should have only one job. If a class has more than one responsibility, it becomes coupled to multiple domains, meaning changes in one domain can break code in another.

**The test**: Can you describe what your class does in one sentence without using "and"?

---

## Detection

**Flag** if class/module has:
- >3 distinct reasons to change
- Methods that operate on different data sources
- Mix of infrastructure and business logic
- State managed for multiple concerns

**Good indicators**:
- Class name contains multiple concepts (UserAuthHandler, OrderValidatorAndProcessor)
- Difficulty explaining class purpose
- Changes often require modifications to unrelated code

---

## Examples

### BAD: Multiple Responsibilities

```typescript
class UserManager {
  // Responsibility 1: Authentication
  authenticate(username: string, password: string): boolean { ... }
  
  // Responsibility 2: Data persistence
  saveUser(user: User): void { ... }
  
  // Responsibility 3: Email notifications
  sendWelcomeEmail(user: User): void { ... }
  
  // Responsibility 4: Logging/Audit
  logAction(action: string, user: User): void { ... }
  
  // Responsibility 5: Analytics
  trackEvent(event: string, user: User): void { ... }
}
```

**Problem**: Change in email provider affects authentication logic. Change in logging affects user storage.

### GOOD: Single Responsibility

```typescript
class Authenticator {
  authenticate(username: string, password: string): boolean { ... }
}

class UserRepository {
  saveUser(user: User): void { ... }
}

class EmailService {
  sendWelcomeEmail(user: User): void { ... }
}

class AuditLogger {
  logAction(action: string, context: object): void { ... }
}

class Analytics {
  trackEvent(event: string, properties: object): void { ... }
}
```

---

## Violations vs. Adherence

| Scenario | Violation | Solution |
|---|---|---|
| API controller handles DB + validation + auth | 3 reasons | Extract services |
| "God Model" with 20 methods on 5 domains | Multiple | Split into focused classes |
| Utility class with unrelated helpers | N/A | Separate by domain |
| Service managing state + processing | 2 reasons | Separate data and logic |

---

## Remediation Strategy

1. Identify all reasons the class might change
2. Group methods by responsibility
3. Extract each group into a new class
4. Use composition to assemble them
5. Keep class name reflecting its single purpose

---

## When SRP is Harder

- **Frameworks**: Some frameworks couple concerns (e.g., Django views = request + response + template)
- **Microservices**: Sometimes multiple responsibilities in one service is intentional
- **Trade-off**: More classes can mean more indirection

**Solution**: Group related responsibilities into a "component" that changes together.