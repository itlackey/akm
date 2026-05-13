# Complexity: Coupling

Understanding code coupling and instability.

## Definitions

### Afferent Coupling (Ca)
**Number of other modules that depend on this module.**

- High Ca = "Changing this will affect many others"
- High impact to fix - many things might break

### Efferent Coupling (Ce)
**Number of other modules this module depends on.**

- High Ce = "This depends on many others"
- High fragility - changes in dependencies break this

### Instability (I)
`I = Ce / (Ca + Ce)`

- Range: 0 to 1
- I = 1: Very unstable (depends on everything, nothing depends on it)
- I = 0: Very stable (nothing depends on it, everything depends on it)

---

## Interpretation

| Instability | Meaning | Risk |
|---|---|---|
| 0.0 - 0.3 | Stable | Safe to refactor, few dependents |
| 0.3 - 0.7 | Moderate | Manageable, test well |
| 0.7 - 1.0 | Unstable | Risky, changes propagate, likely to break |

---

## Examples

### Stable Module (I near 0)

```
Module A
  - Ca: 15 (15 modules depend on A)
  - Ce: 1 (depends on 1 module)
  - I = 1/(15+1) = 0.06
  - "Core module, everything depends on it"
```

**Risk**: Change affects 15 other modules.

### Unstable Module (I near 1)

```
Module Z
  - Ca: 0 (nothing depends on Z)
  - Ce: 12 (depends on 12 modules)
  - I = 12/(0+12) = 1.0
  - "Leaf module, depends on everything"
```

**Risk**: Changes to any of 12 dependencies can break Z.

---

## What to Flag

| Metric | Threshold | Issue |
|---|---|---|
| Efferent (Ce) | >10 | Too many dependencies |
| Afferent (Ca) | >15 | Too many dependents - high impact change |
| Instability | >0.7 | Unstable - risk of breaking |
| Instability | <0.2 | Could be a "god module" - analyze |

---

## Tools to Measure

```bash
# JavaScript/TypeScript
npm install -g depcruise
depcruise src/ --output-type err

# Python - pylint shows import coupling
pylint --import-graph=graph.txt .

# Java - SonarQube shows coupling metrics

# Go
go list -f '{{.Imports}}' ./...
```

---

## Remediation

### Reduce Efferent (Ce)
- Extract interfaces to break dependencies
- Use dependency injection
- Create abstractions for external libraries

### Reduce Afferent (Ca)  
- Apply Adapter pattern for boundaries
- Use Facade to hide internals
- Break up "god modules"

### Manage Instability
- Unstable modules should depend on stable ones
- Stable modules (I near 0) are good places for interfaces
- Dependencies should point inward (stable → stable)

---

## Dependency Direction Principle

```
Stable packages should depend on stable packages

         Stable (I=0.1)
           ▲
           │
           │ depends on
           │
         Unstable (I=0.9)


NOT like this:

         Unstable (I=0.9)
           ▼
           │
           │ depends on
           │
         Stable (I=0.1)   ← BAD - unstable depends on stable
```

---

## Summary

| Metric | Good | Warning |
|---|---|---|
| Efferent (Ce) | <5 | >10 |
| Afferent (Ca) | <10 | >15 |
| Instability (I) | 0.2-0.6 | >0.7 or <0.1 |