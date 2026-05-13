# Output: Examples

Example findings for each category to illustrate quality and completeness.

---

## Structural Anti-Patterns

### Example 1: God Object

```markdown
### [CRITICAL] OrderService is a God Object

- **File**: src/services/OrderService.ts
- **Lines**: 1-156
- **Category**: structural
- **Pattern**: God Object

- **Current**:
  ```typescript
  class OrderService {
    // Database operations
    async create(data): Promise<Order> { ... }
    async findById(id): Promise<Order | null> { ... }
    async update(id, data): Promise<Order> { ... }
    async delete(id): Promise<void> { ... }
    
    // Email notifications
    async sendConfirmation(order): Promise<void> { ... }
    async sendShippingNotice(order): Promise<void> { ... }
    async sendRefundConfirmation(order): Promise<void> { ... }
    
    // PDF generation
    async generateInvoice(order): Promise<Buffer> { ... }
    async generatePackingSlip(order): Promise<Buffer> { ... }
    async generateLabel(order): Promise<Buffer> { ... }
    
    // Payment processing
    async processPayment(order): Promise<PaymentResult> { ... }
    async refund(order): Promise<RefundResult> { ... }
    async capturePayment(order): Promise<void> { ... }
    
    // Logging & metrics
    logMetrics(order): void { ... }
    createAuditTrail(order): void { ... }
  }
  ```

- **Issue**: This class manages 5+ distinct domains (data access, email, PDF generation, payments, logging). A change to invoice PDF generation could break payment processing. Testing requires mocking email, PDF, and payment systems.

- **Impact**: maintainability, correctness

- **Fix**: Extract into focused services:
  ```typescript
  class OrderRepository { /* data access only */ }
  class EmailNotifier { /* emails only */ }
  class PdfGenerator { /* PDFs only */ }
  class PaymentProcessor { /* payments only */ }
  class AuditLogger { /* logging only */ }
  ```

- **Effort**: high (days)
```

### Example 2: Feature Envy

```markdown
### [WARNING] OrderCalculator heavily envies Customer

- **File**: src/services/OrderCalculator.ts
- **Lines**: 23-45
- **Category**: structural
- **Pattern**: Feature Envy

- **Current**:
  ```typescript
  calculateDiscount(order: Order): number {
    const customer = order.customer;
    
    // More interest in Customer than Order
    if (customer.type === 'VIP' &&
        customer.lifetimeValue > 10000 &&
        customer.ordersCount > 50 &&
        customer.averageRating > 4.5 &&
        customer.lastOrderDate.daysAgo < 30) {
      return 0.20;
    }
    return 0;
  }
  ```

- **Issue**: The method operates on Customer data more than Order data. This logic belongs on Customer, not OrderCalculator.

- **Impact**: maintainability

- **Fix**: Move to Customer class:
  ```typescript
  // In Customer.ts
  getDiscountRate(): number {
    if (this.isVIP && this.lifetimeValue > 10000 && ...) {
      return 0.20;
    }
    return 0;
  }
  ```

- **Effort**: low (minutes)
```

---

## SOLID Violations

### Example: SRP Violation

```markdown
### [CRITICAL] UserService violates Single Responsibility

- **File**: src/services/UserService.ts
- **Lines**: 1-95
- **Category**: solid
- **Pattern**: SRP - Single Responsibility Principle

- **Current**: Class has 4 reasons to change:
  1. Validation logic changes
  2. Database schema changes
  3. Email template changes
  4. Logging format changes

- **Issue**: Changing email templates affects database queries. Modifying validation requires full integration test with all 4 concerns.

- **Impact**: maintainability, correctness

- **Fix**: Split into:
  ```typescript
  class UserValidator { }
  class UserRepository { }  
  class UserNotifier { }
  class UserActivityLogger { }
  ```

- **Effort**: medium (hours)
```

---

## Complexity

### Example: High Cyclomatic Complexity

```markdown
### [WARNING] processPayment has cyclomatic complexity of 23

- **File**: src/services/PaymentService.ts
- **Lines**: 45-98
- **Category**: complexity
- **Pattern**: Cyclomatic Complexity >20

- **Current**:
  ```typescript
  async processPayment(payment: Payment): Promise<Result> {
    if (payment.method === 'card') {         // +1
      if (payment.amount > 0) {              // +1
        if (payment.currency) {              // +1
          if (payment.card) {                // +1
            if (payment.card.isValid) {      // +1
              if (this.validateCard(payment.card)) {  // +1
                // 17 more nested conditions... 
  ```

- **Issue**: 23 decision paths means minimum 23 test cases needed. Logic is nearly impossible to understand or safely modify.

- **Impact**: maintainability, correctness

- **Fix**: Extract methods:
  ```typescript
  async processPayment(payment): Promise<Result> {
    if (!this.isValidPayment(payment)) {
      return invalidResult();
    }
    if (!this.hasRequiredPermissions()) {
      return permissionResult();
    }
    return this.executePayment(payment);
  }
  ```

- **Effort**: medium (hours)
```

---

## Code Style

### Example: Magic Numbers

```markdown
### [SUGGESTION] Magic numbers in shipping calculation

- **File**: src/services/ShippingCalculator.ts
- **Lines**: 12-15
- **Category**: style
- **Pattern**: Magic Numbers

- **Current**:
  ```typescript
  const baseRate = weight * 0.5;
  const fuelSurcharge = weight * 0.15;
  const ruralFee = weight > 50 ? 25 : 10;
  ```

- **Issue**: Numbers have no explanation. What is 0.5? What does 50 represent? Future developers will guess.

- **Impact**: maintainability

- **Fix**: Extract to named constants:
  ```typescript
  const BASE_RATE_PER_KG = 0.5;
  const FUEL_SURCHARGE_RATE = 0.15;
  const RURAL_THRESHOLD_KG = 50;
  const RURAL_FEE = 25;
  const STANDARD_FEE = 10;
  
  const baseRate = weight * BASE_RATE_PER_KG;
  const fuelSurcharge = weight * FUEL_SURCHARGE_RATE;
  const ruralFee = weight > RURAL_THRESHOLD_KG ? RURAL_FEE : STANDARD_FEE;
  ```

- **Effort**: low (minutes)
```

---

## Design Patterns Missing

### Example: State Pattern Opportunity

```markdown
### [WARNING] Order status managed with boolean flags

- **File**: src/models/Order.ts
- **Lines**: 8-15
- **Category**: design-patterns
- **Pattern**: State Pattern Missing

- **Current**:
  ```typescript
  class Order {
    isPending: boolean;
    isProcessing: boolean;
    isShipped: boolean;
    isDelivered: boolean;
    isCancelled: boolean;
    isRefunded: boolean;
  }
  
  // Usage
  if (order.isPending && !order.isCancelled) { ... }
  if (!order.isDelivered && order.isShipped) { ... }
  ```

- **Issue**: 6 boolean flags control order state. Invalid combinations possible. New states require adding more booleans. Transitions are implicit in scattered conditionals.

- **Impact**: maintainability, correctness

- **Fix**: Apply State pattern:
  ```typescript
  interface OrderState {
    canShip(): boolean;
    canCancel(): boolean;
    ship(): OrderState;
    cancel(): OrderState;
  }
  
  class PendingState implements OrderState {
    canShip() { return true; }
    ship() { return new ShippedState(); }
  }
  ```

- **Effort**: medium (hours)
```