---
name: codebase-refactor-review
description: Examine a codebase for design pattern violations and refactoring opportunities. See references/ for detailed topic guides.
tags:
  - review
  - refactor
  - design-patterns
  - code-quality
  - architecture
  - anti-patterns
  - complexity
searchHints:
  - codebase refactoring review
  - anti-pattern detection
  - code quality audit
  - design pattern audit
  - complexity analysis
quality: curated
---

# Codebase Refactor Review

You are performing an exhaustive architectural and code-quality review of a codebase. Your mission is to surface every area where the code deviates from high-quality engineering standards, known design patterns, and established best practices.

**For detailed information on each topic, see the references/ directory.**

---

## Scope of Review

### 1. Structural Anti-Patterns
See: `references/anti-patterns/structural.md`

| Anti-Pattern | Threshold |
|---|---|
| God Object | >5 distinct responsibilities |
| Spaghetti Code | Tangled control flow |
| Copy-Paste Duplication | >10 identical lines |
| Shotgun Surgery | Single change needs >5 edits |
| Feature Envy | Method uses more foreign than own data |
| Inappropriate Intimacy | Reaches into private internals |
| Primitive Obsession | Raw primitives instead of domain types |
| Data Clumps | 3+ params/fields always together |
| Switch/Case Abuse | >4 branches on type/enum |
| Dead Code | Unused variables/functions/imports |
| Lazy Class | <100 lines, <3 methods |
| Speculative Generality | Abstractions with 1 implementation |

### 2. Creational Anti-Patterns
See: `references/anti-patterns/creational.md`

| Anti-Pattern | Threshold |
|---|---|
| Raw Constructor Overuse | >4 parameters |
| Hidden Dependencies | `new` in business logic |
| Singleton Abuse | Global mutable state |
| Missing Factory | Duplicated object creation |
| Missing Builder | Complex construction without builder |

### 3. Behavioral Anti-Patterns
See: `references/anti-patterns/behavioral.md`

| Anti-Pattern | Threshold |
|---|---|
| Callback Hell | >3 nested async levels |
| Magic Numbers | Unnamed hardcoded literals |
| Flag Arguments | Boolean params toggle behavior |
| Comment Deodorant | Comments explain what not why |
| Inconsistent Error Handling | Mixed exception/return/sentinel |
| Silent Failure | Swallowed exceptions not acted on |
| Timeout Abuse | Arbitrary long timeouts |

### 4. SOLID Principles
See: `references/solid/` (individual files for each)

- **SRP**: >3 responsibilities = violation
- **OCP**: Requires source changes to extend = violation
- **LSP**: Overrides break parent contracts = violation
- **ISP**: Interfaces with >8 methods = violation
- **DIP**: High-level instantiates low-level = violation

### 5. Design Pattern Opportunities
See: `references/design-patterns/` (creational, structural, behavioral)

Flag where these are MISSING:

**Creational**: Factory, Abstract Factory, Builder, Singleton, Prototype

**Structural**: Adapter, Decorator, Facade, Composite, Proxy

**Behavioral**: Strategy, Observer, Command, State, Chain of Responsibility, Iterator, Template Method, Memento

### 6. Complexity Metrics
See: `references/complexity/`

| Metric | Flag Threshold | Critical Threshold |
|---|---|---|
| Cyclomatic Complexity | >10 | >20 |
| Method/Function Length | >50 lines | >100 lines |
| Parameter Count | >4 | >6 |
| Inheritance Depth | >4 levels | — |
| File Size (source) | >300 lines | — |
| File Size (config) | >100 lines | — |
| Cognitive Complexity | >4 nesting levels | — |

**Coupling thresholds**: See `references/complexity/coupling.md`
- Efferent >10 = warning
- Instability >0.7 = unstable

### 7. Code Style & Convention
See: `references/code-style/`

- Naming consistency (camelCase, PascalCase, snake_case)
- Import organization and unused imports
- Formatting (indentation, braces, spacing)
- Documentation (public APIs, internal functions)
- Type annotations (any/dynamic usage)
- Stale comments (TODO, FIXME, HACK)
- Test presence on critical paths

---

## Output Format

See: `references/output/templates.md`

Produce findings in this exact format:

```markdown
### [CRITICAL|WARNING|SUGGESTION] Finding Title

- **File**: relative path
- **Lines**: specific line numbers
- **Category**: structural|creational|behavioral|solid|complexity|style
- **Pattern**: relevant pattern or principle name
- **Current**: brief code excerpt
- **Issue**: precise problem description
- **Impact**: maintainability / correctness / performance / security
- **Fix**: specific remediation with before/after code
- **Effort**: low (minutes) / medium (hours) / high (days)
```

---

## Deliverables (produce all four)

1. **Executive Summary** — health score 1-10, counts by severity, top 3 priorities
2. **Full Findings** — every issue, organized by category
3. **Design Pattern Map** — what's used well, what's missing
4. **Refactoring Roadmap** — ordered by impact × effort, grouped by phase

**Be thorough.** The user expects nothing less than a completely exhaustive analysis.