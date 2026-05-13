# Design Patterns: Creational

When and how to apply creational patterns.

## Factory Method

**Intent**: Define an interface for creating an object, but let subclasses decide which class to instantiate.

**When to Apply**:
- A class can't anticipate the class of objects it must create
- Subclasses should specify the objects they create
- You want to delegate responsibility to subclasses

**Red Flag**: Scattered object creation logic across multiple call sites.

```typescript
// Before: Scattered creation
function processUser(type: 'admin' | 'guest' | 'member') {
  let user;
  if (type === 'admin') user = new AdminUser();
  else if (type === 'guest') user = new GuestUser();
  else user = new MemberUser();
  // ...
}

// After: Factory
interface UserFactory {
  create(): User;
}

class AdminUserFactory implements UserFactory {
  create(): User { return new AdminUser(); }
}
```

---

## Abstract Factory

**Intent**: Provide an interface for creating families of related objects without specifying concrete classes.

**When to Apply**:
- System should work with multiple families of products
- You want to provide a library without exposing implementation
- Complex creation logic with dependencies

**Red Flag**: Creation logic depends on environment/config combinations.

---

## Builder

**Intent**: Separate the construction of a complex object from its representation.

**When to Apply**:
- Object creation has many optional parameters
- Construction involves multiple steps
- Same construction process should create different representations

**Red Flag**: Telescoping constructors, many constructor overloads.

```typescript
// Before: Telescoping constructor
new Email(to, from, subject, body, priority, cc, bcc, attachments);

// After: Builder
new EmailBuilder()
  .to("bob@example.com")
  .from("alice@example.com")
  .subject("Hello")
  .body("Content")
  .priority(High)
  .build();
```

---

## Singleton

**Intent**: Ensure a class has only one instance and provide a global point of access to it.

**When to Apply**:
- Exactly one instance of a resource (database, logger)
- Lazy initialization is needed
- Strict control over global state

**When NOT to Use**:
- Testing requires isolation
- Multiple instances might be needed later
- Creates hidden global state

**Red Flag**: "There's only one of these" without thinking about testability.

**Modern Alternative**: Dependency injection handles singleton-like behavior without the pattern's drawbacks.

---

## Prototype

**Intent**: Specify the kinds of objects to create using a prototypical instance, and create new objects by copying this prototype.

**When to Apply**:
- Creating objects is expensive
- Objects have many optional fields
- Need to avoid subclassing for configuration

**Red Flag**: Cloning logic copied in multiple places, or "copy constructor" pattern.

---

## Summary Table

| Pattern | Use When | Red Flag |
|---|---|---|
| Factory Method | Subclass decides creation | Creation if/else scattered |
| Abstract Factory | Multiple product families | Environment-based config |
| Builder | Many optional params | Telescoping constructors |
| Singleton | Exactly one instance needed | "Only one" without DI |
| Prototype | Expensive object creation | Manual cloning code |