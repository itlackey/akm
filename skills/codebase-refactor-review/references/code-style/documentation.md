# Code Style: Documentation

When and how to document code.

## Principle

**Good code is self-documenting.** Write code that doesn't need comments first. Then add comments to explain *why*, not *what*.

---

## What NOT to Document

### 1. What the code does (if code is clear)

```typescript
// BAD - repeats code
// Increment counter by 1
counter++;

// BAD - obvious
// Check if user is active
if (user.isActive) { }

// BAD - describes implementation, not intent
// Loop through items
for (const item of items) { }
```

### 2. Empty functions

```typescript
// BAD - comment-only function
function process() {
  // Process the order
}
```

### 3. Commented-out code

```typescript
// BAD - dead code
// const oldCalculation = x * 2;
```

---

## What TO Document

### 1. Why (when non-obvious)

```typescript
// GOOD - explains business reason
// Retry 3 times because payment provider occasionally
// times out on first attempt due to warm-up latency
const MAX_RETRIES = 3;
```

### 2. Complex algorithms

```typescript
// GOOD - explains approach
// Using binary search because dataset is sorted and
// we need O(log n) lookup for real-time UI
const findUser = (users: User[], targetId: string) => { ... }
```

### 3. API contracts

```typescript
/**
 * Creates a new order.
 * 
 * @param data - Order creation data
 * @returns Created order with generated ID
 * @throws ValidationError if data is invalid
 * @throws PaymentError if payment fails
 */
async function createOrder(data: OrderData): Promise<Order>
```

### 4. Workarounds

```typescript
// GOOD - explains workaround and ticket
// Workaround for Safari 15- animation bug
// TODO: Remove after Safari 15 support ends
// Ticket: EXP-1234
element.style.transform = 'translate3d(0,0,0)';
```

---

## API Documentation

### Functions/Methods

```typescript
/**
 * Calculates the total price including tax and discounts.
 * 
 * @param items - Cart items to calculate
 * @param taxRate - Tax rate as decimal (0.1 = 10%)
 * @param discountCode - Optional discount code
 * @returns Total price in cents
 * @throws InvalidDiscountError if code is invalid
 * 
 * @example
 * const total = calculateTotal(cartItems, 0.08, 'SAVE20');
 */
function calculateTotal(
  items: CartItem[],
  taxRate: number,
  discountCode?: string
): number
```

### Classes

```typescript
/**
 * Manages user authentication and session lifecycle.
 * 
 * Responsibilities:
 * - Login/logout flow
 * - Token refresh
 * - Session state
 * - Security checks
 * 
 * Note: This class depends on AuthProvider which must
 * be configured before use. See AuthModule.setup().
 */
class AuthManager { }
```

---

## When Documentation is Missing

| Element | Minimum |
|---|---|
| Public function | JSDoc/docstring with params and return |
| Class | What it does, key responsibilities |
| Complex algorithm | Explain approach in comments |
| Non-obvious "why" | Explain business reason |
| Configuration | What each field means |
| Public API | Full documentation |

---

## Documentation Tools

| Type | Tool |
|---|---|
| JSDoc | /\*\* \*/ comments, generates HTML |
| TypeScript | Types as documentation |
| Python | Sphinx, docstrings |
| Go | godoc comments |
| Rust | doc comments /// |

---

## Checklist

- [ ] Does each public function have param/return docs?
- [ ] Are complex algorithms explained?
- [ ] Are there comments explaining non-obvious choices?
- [ ] Is there a class/module overview?
- [ ] Are TODO/FIXME/Ticket references current?
- [ ] Do documentation match the actual code?
- [ ] Is there documentation for configuration? |