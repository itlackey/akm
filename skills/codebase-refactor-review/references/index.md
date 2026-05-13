# Codebase Refactor Review — Reference Index

Master index of detailed reference topics with line number references.

---

## Anti-Patterns

### Structural Anti-Patterns
- **File**: `anti-patterns/structural.md`
- **Topics**:
  - God Object: lines 1-35
  - Spaghetti Code: lines 37-58
  - Copy-Paste Programming: lines 60-80
  - Shotgun Surgery: lines 82-97
  - Feature Envy: lines 99-116
  - Inappropriate Intimacy: lines 118-135
  - Primitive Obsession: lines 137-155
  - Data Clumps: lines 157-174
  - Switch/Case Abuse: lines 176-195
  - Dead Code: lines 197-214
  - Lazy Class: lines 216-229
  - Speculative Generality: lines 231-245

### Creational Anti-Patterns
- **File**: `anti-patterns/creational.md`
- **Topics**:
  - Raw Constructor Overuse: lines 1-20
  - Hidden Dependencies: lines 22-36
  - Singleton Abuse: lines 38-55
  - Missing Factory: lines 57-79
  - Missing Builder: lines 81-108

### Behavioral Anti-Patterns
- **File**: `anti-patterns/behavioral.md`
- **Topics**:
  - Callback Hell: lines 1-24
  - Magic Numbers: lines 26-42
  - Flag Arguments: lines 44-61
  - Comment Deodorant: lines 63-76
  - Inconsistent Error Handling: lines 78-98
  - Silent Failure: lines 100-120
  - Timeout Abuse: lines 122-148

---

## SOLID Principles

| Principle | File | Lines |
|---|---|---|
| Single Responsibility (SRP) | `solid/srp.md` | 1-77 |
| Open/Closed (OCP) | `solid/ocp.md` | 1-93 |
| Liskov Substitution (LSP) | `solid/lsp.md` | 1-110 |
| Interface Segregation (ISP) | `solid/isp.md` | 1-87 |
| Dependency Inversion (DIP) | `solid/dip.md` | 1-126 |

---

## Design Patterns

### Creational Patterns
- **File**: `design-patterns/creational.md`
- **Topics**:
  - Factory Method: lines 1-24
  - Abstract Factory: lines 26-35
  - Builder: lines 37-57
  - Singleton: lines 59-77
  - Prototype: lines 79-86

### Structural Patterns
- **File**: `design-patterns/structural.md`
- **Topics**:
  - Adapter: lines 1-29
  - Decorator: lines 31-60
  - Facade: lines 62-89
  - Composite: lines 91-123
  - Proxy: lines 125-131

### Behavioral Patterns
- **File**: `design-patterns/behavioral.md`
- **Topics**:
  - Strategy: lines 1-31
  - Observer/Event Emitter: lines 33-55
  - Command: lines 57-90
  - State: lines 92-131
  - Chain of Responsibility: lines 133-161
  - Iterator: lines 163-170
  - Template Method: lines 172-179
  - Memento: lines 181-188

---

## Complexity Metrics

| Metric | File | Lines |
|---|---|---|
| Cyclomatic Complexity | `complexity/cyclomatic.md` | 1-89 |
| Cognitive Complexity | `complexity/cognitive.md` | 1-82 |
| Coupling (Afferent/Efferent/Instability) | `complexity/coupling.md` | 1-108 |

---

## Code Style

| Topic | File | Lines |
|---|---|---|
| Naming Conventions | `code-style/naming.md` | 1-96 |
| Formatting Standards | `code-style/formatting.md` | 1-97 |
| Documentation Guidelines | `code-style/documentation.md` | 1-96 |

---

## Output

| Topic | File | Lines |
|---|---|---|
| Finding Template | `output/templates.md` | 1-109 |
| Example Findings | `output/examples.md` | 1-170 |

---

## Quick Reference: Thresholds

| Metric | Flag | Critical |
|---|---|---|
| Cyclomatic Complexity | >10 | >20 |
| Constructor Parameters | >4 | — |
| Method Length | >50 lines | >100 lines |
| File Size (source) | >300 lines | — |
| Inheritance Depth | >4 levels | — |
| Parameter Count | >4 | >6 |
| Interface Methods | >8 | — |
| Responsibilities per Class | >3 | >5 |