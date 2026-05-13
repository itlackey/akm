# Anti-Patterns: Behavioral

Detailed reference for behavioral anti-patterns detection and remediation.

## 1. Callback Hell

**Definition**: Deeply nested asynchronous callbacks creating unreadable control flow.

**Detection**:
- >3 levels of nested callbacks
- `.then()` chains >3 levels deep
- Pyramid-shaped code structure
- Hard to track variable scope

**Example**:
```javascript
// BAD: Callback hell
getUser(userId, (err, user) => {
    if (err) {
        handleError(err);
        return;
    }
    getOrders(user.id, (err, orders) => {
        if (err) {
            handleError(err);
            return;
        }
        getProducts(orders.map(o => o.productId), (err, products) => {
            if (err) {
                handleError(err);
                return;
            }
            getPricing(products, (err, prices) => {
                if (err) {
                    handleError(err);
                    return;
                }
                processOrder(user, orders, products, prices, (err, result) => {
                    // ... more nesting
                });
            });
        });
    });
});
```

**Remediation**: Use Promises, async/await, or functional composition. Extract callbacks to named functions.

---

## 2. Magic Numbers

**Definition**: Unnamed hardcoded literals that obscure intent.

**Detection**:
- Numeric literals without explanation
- String literals repeated across code
- "What does 86400 mean?" comments
- Same number used in multiple places with different meanings

**Example**:
```python
# BAD: Magic numbers
def process_payment(amount, card):
    if amount > 10000:  # What is 10000?
        raise Exception("Too large")
    
    if card.expiry < 30:  # 30 what? Days?
        raise Exception("Expired")
    
    time.sleep(2)  # Why 2 seconds?
    
    if amount * 0.029 + 0.30 > amount * 0.03:  # Unreadable
        apply_discount(amount)
```

**Remediation**: Create named constants, use enums for related values, extract magic strings to config.

---

## 3. Flag Arguments

**Definition**: Boolean parameters that toggle behavior, making calls unclear.

**Detection**:
- Method takes boolean that changes what it does
- Callers pass `true`/`false` without explanation
- Impossible to remember parameter order
- Adding features requires adding more booleans

**Example**:
```typescript
// BAD: Flag arguments
function processOrder(order, notify, validate, log, async) {
  if (validate) { /* ... */ }
  if (notify) { /* ... */ }
  // Different behavior based on flags
}

// Usage - what does true/false mean?
processOrder(order, true, false, true, false);
processOrder(order, false, true, false, true);
// Impossible to know what's happening without reading implementation
```

**Remediation**: Split into named methods, use configuration objects, use the strategy pattern.

---

## 4. Comment Deodorant

**Definition**: Comments that explain what code does instead of why, masking poor code.

**Detection**:
- Comments describe the obvious
- Comments repeat what code already says
- No comments on complex logic
- Comments say "what" not "why"

**Example**:
```javascript
// BAD: Comment deodorant
// Increment counter by 1
counter++;

// Loop through items
for (const item of items) {
  // Check if item is valid
  if (item.isValid()) {
    // Process the item
    process(item);
  }
}

// TODO: This is confusing, maybe fix later
// (No explanation of why or what should be fixed)
```

**Remediation**: Write self-documenting code, use comments for "why" not "what", refactor confusing code.

---

## 5. Inconsistent Error Handling

**Definition**: Mixed strategies for handling errors across the codebase.

**Detection**:
- Some functions throw exceptions, others return null/error
- Error codes mixed with exceptions
- Silent failures (swallowed errors)
- Different error types for same scenarios

**Example**```typescript
// BAD: Inconsistent error handling
function getUser(id: string): User | null {
  // Returns null
  const user = db.find(id);
  if (!user) return null;
  return user;
}

async function createOrder(data: OrderData): Order {
  // Throws exception
  if (!data.items.length) {
    throw new Error('No items');
  }
  return await orderRepo.save(data);
}

function findItem(id: string): Item {
  // Uses sentinel value
  const item = cache.get(id);
  if (!item) return Item.NOT_FOUND;
  return item;
}
```

**Remediation**: Choose single strategy (exceptions or Result types), be consistent, document strategy.

---

## 6. Silent Failure

**Definition**: Errors are caught and logged but not properly handled or propagated.

**Detection**:
- Empty catch blocks
- Caught exceptions logged but execution continues
- Errors swallowed in async code
- Failures not propagated to caller

**Example**:
```python
# BAD: Silent failure
try:
    process_payment(order)
except Exception as e:
    logger.error(f"Payment failed: {e}")
    # Execution continues as if nothing happened!

def submit_form(data):
    try:
        send_to_api(data)
    except:
        pass  # Swallowed entirely!
    return {"status": "success"}  # Lies!
```

**Remediation**: Fail fast, propagate errors, retry with backoff, use circuit breakers.

---

## 7. Timeout Abuse

**Definition**: Long arbitrary timeouts used to mask underlying issues.

**Detection**:
- Timeout values like 300, 60, 10 with no explanation
- Timeouts increase over time ("this one fixed it")
- No correlation between timeout and operation
- "Increase timeout" as primary fix for failures

**Example**```go
// BAD: Timeout abuse
func ProcessRequest(ctx context.Context, req Request) Response {
    // Arbitrary 5 minute timeout
    ctx, cancel := context.WithTimeout(ctx, 5*time.Minute)
    defer cancel()
    
    // Why 5 minutes? What happens at 4:59?
    // What if it takes 6 minutes?
}

func FetchData() error {
    // Another random timeout
    client := &http.Client{Timeout: 30 * time.Second}
    
    // This sometimes takes 45 seconds, so keep increasing
    client.Timeout = 60 * time.Second
    client.Timeout = 120 * time.Second  // Now it's 2 minutes!
}
```

**Remediation**: Understand actual operation times, use retry with backoff, implement circuit breakers.