# Output: Templates

Finding template and output format for code review results.

---

## Finding Template

Each finding must include all of these fields:

```markdown
### [SEVERITY] Finding Title

- **File**: relative/path/to/file.ts
- **Lines**: 45-67
- **Category**: structural | creational | behavioral | solid | complexity | style
- **Pattern**: name of relevant anti-pattern or principle
- **Current**: 
  ```typescript
  // Brief code excerpt (3-5 lines max)
  class UserManager {
    create() { ... }
    update() { ... }
    delete() { ... }
    authenticate() { ... }
    sendEmail() { ... }  // 5+ responsibilities!
  }
  ```
- **Issue**: Clear, specific description of what is wrong
- **Impact**: maintainability | correctness | performance | security
- **Fix**: 
  ```typescript
  // Before/after or explanation
  class UserService { create() { ... } }
  class AuthService { authenticate() { ... } }
  class EmailService { sendEmail() { ... } }
  ```
- **Effort**: low (minutes) | medium (hours) | high (days)
```

---

## Severity Levels

| Level | When to Use |
|---|---|
| **CRITICAL** | Production impact, security risk, data loss potential |
| **WARNING** | Maintainability issue, technical debt, could cause future bugs |
| **SUGGESTION** | Code style, minor improvements, nice-to-have |

---

## Category Labels

| Category | What It Covers |
|---|---|
| structural | God Object, Feature Envy, etc. |
| creational | Constructor over-injection, Factory missing, etc. |
| behavioral | Flag arguments, Magic numbers, etc. |
| solid | SRP, OCP, LSP, ISP, DIP violations |
| complexity | Cyclomatic, cognitive, coupling metrics |
| style | Naming, formatting, documentation |

---

## Example: Complete Finding

```markdown
### [WARNING] UserManager violates Single Responsibility

- **File**: src/services/UserManager.ts
- **Lines**: 1-89
- **Category**: solid
- **Pattern**: SRP - Single Responsibility Principle
  
- **Current**: 
  ```typescript
  class UserManager {
    createUser(data) { /* ... */ }     // Data operations
    validateUser(user) { /* ... */ }   // Validation
    sendWelcomeEmail(user) { /* ... */ }  // Email
    generateReport(type) { /* ... */ }  // Reporting
    logActivity(action) { /* ... */ }   // Logging
    calculateMetrics() { /* ... */ }    // Analytics
  }
  ```
  
- **Issue**: This class has 6 distinct responsibilities. Changing the 
  email format affects user creation code. Adding a new report type 
  risks breaking user validation. The class changes for multiple reasons.
  
- **Impact**: maintainability
  
- **Fix**: 
  ```typescript
  class UserRepository { createUser(), validateUser() }
  class EmailService { sendWelcomeEmail() }
  class ReportGenerator { generateReport() }
  class ActivityLogger { logActivity() }
  class MetricsCalculator { calculateMetrics() }
  ```
  
- **Effort**: medium (hours)
```

---

## Output Sections

### 1. Executive Summary

```markdown
## Executive Summary

**Overall Health Score**: 6/10

**Findings by Severity**:
- CRITICAL: 2
- WARNING: 15
- SUGGESTION: 8

**Top 3 Priorities**:
1. Refactor OrderService (SRP violation) - high impact
2. Remove duplicate validation logic (Copy-Paste) - easy fix
3. Add missing type annotations - moderate effort
```

### 2. Design Pattern Map

```markdown
## Design Pattern Map

**Used Well**:
- Repository pattern in data layer
- Factory in object creation

**Missing** (where they'd help):
- Strategy: `src/services/ShippingCalculator.ts` - conditionals for shipping types
- Observer: `src/core/State.ts` - state changes don't notify dependents
- Command: `src/actions/` - actions should be undoable
```

### 3. Refactoring Roadmap

```markdown
## Refactoring Roadmap

### Phase 1: Quick Wins (1-2 hours)
1. [LOW] Remove unused imports - `src/utils/format.ts:5`
2. [LOW] Extract magic numbers to constants - `src/config.ts:10-25`

### Phase 2: Core Refactoring (1-2 days)
3. [MEDIUM] Split UserManager - `src/services/UserManager.ts:1-89`
4. [MEDIUM] Add missing types - `src/api/*.ts`

### Phase 3: Architectural (1+ week)
5. [HIGH] Add Strategy pattern for shipping - `src/services/ShippingCalculator.ts`
6. [HIGH] Implement Repository pattern - `src/services/*.ts`
```