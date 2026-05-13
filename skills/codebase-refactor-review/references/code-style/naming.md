# Code Style: Naming

Naming conventions and best practices.

## Core Principle

**Names should reveal intent.** The name should answer: "What does this represent?" or "What does this do?"

---

## Language Conventions

| Language | Variables | Functions/Methods | Classes | Constants |
|---|---|---|---|---|
| JavaScript/TypeScript | camelCase | camelCase | PascalCase | UPPER_SNAKE or camelCase |
| Python | snake_case | snake_case | PascalCase | UPPER_SNAKE |
| Java | camelCase | camelCase | PascalCase | UPPER_SNAKE |
| Go | camelCase | camelCase | PascalCase | MixedCase (no _) |
| Rust | snake_case | snake_case | PascalCase | UPPER_SNAKE |
| C# | camelCase | PascalCase | PascalCase | PascalCase |

---

## Rules

### 1. Variables and Functions

**DO**: `userCount`, `getUserById`, `isActive`, `orders`

**DON'T**: `x`, `data`, `temp`, `thing`, `doStuff`

**Bad Examples**:
```typescript
const x = userList.length;         // What is x?
const temp = calculate();          // Temporary?
const data = fetchData();          // What kind of data?
function doIt() { }                // Does what?
```

### 2. Classes and Types

**DO**: `UserService`, `OrderProcessor`, `HttpClient`

**DON'T**: `Manager`, `Handler`, `Helper`, `Utils`

**Bad Examples**:
```typescript
class Manager { }           // Manages what?
class DataHelper { }        // Helper for data? What data?
class Utils { }             // Contains what utilities?
```

### 3. Booleans

**DO**: `isActive`, `hasPermission`, `canEdit`, `isValid`, `enabled`

**DON'T**: `is`, `flag`, `check`, `val`

**Bad Examples**:
```typescript
const active = true;        // What is active?
const check = validate();   // Check what?
const flag = true;          // Flag for what?
```

### 4. Constants

**DO**: `MAX_RETRY_COUNT`, `DEFAULT_TIMEOUT_MS`

**DON'T**: `max`, `timeout`, `retry`

**Examples**:
```typescript
const MAX_RETRY_COUNT = 3;
const DEFAULT_TIMEOUT_MS = 30000;
const API_BASE_URL = 'https://api.example.com';
```

### 5. Avoid Magic Numbers/Strings

**DO**: Named constants

**DON'T**: Literal values

**Bad Examples**:
```typescript
if (user.role === 'admin')  // What is 'admin'?
await delay(2000);          // What is 2000?
```

**Good**:
```typescript
const ROLE_ADMIN = 'admin';
const DEFAULT_DELAY_MS = 2000;

if (user.role === ROLE_ADMIN)
await delay(DEFAULT_DELAY_MS);
```

---

## Naming Quiz

| Bad Name | Why | Better Name |
|---|---|---|
| `getData()` | What data? | `getUsers()`, `fetchUserList()` |
| `process()` | Process what? | `processOrder()`, `validatePayment()` |
| `items` | What items? | `orderItems`, `cartProducts` |
| `config` | What config? | `appConfig`, `databaseConfig` |
| `handleError()` | Handle how? | `logError()`, `retryOnError()` |
| `list` | List of what? | `userList`, `activeOrders` |
| `result` | Result of what? | `queryResult`, `calculationResult` |

---

## When to Rename

- Name describes implementation, not intent
- Name is too short to be meaningful
- Name requires comment to explain
- Name is a generic term (data, info, items)
- Name uses type in name (String userName) - redundant