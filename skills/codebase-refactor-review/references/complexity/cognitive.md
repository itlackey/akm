# Complexity: Cognitive

Understanding cognitive complexity in code.

## Definition

Cognitive Complexity measures how hard code is to understand for humans. Unlike cyclomatic complexity (which measures paths), cognitive complexity measures the mental effort required to parse and comprehend code.

**Key insight**: Code may have low cyclomatic complexity but high cognitive complexity, or vice versa.

---

## Core Principles

1. **Incidental complexity doesn't count**: Only complexity that makes code harder to understand
2. **Breakpoints**: Each time code flow breaks from linear, complexity increases
3. **Nesting**: Each nesting level adds to cognitive load

---

## What Counts

### Flow Breaking

| Break | Example | Adds |
|---|---|---|
| Sequential code | Normal line | 0 |
| If/else | `if (x) { } else { }` | 1 |
| Switch | `switch(x) { case... }` | 1 |
| Loop | `for`, `while`, `do` | 1 |
| Catch | `try/catch` | 1 |
| Goto/label | Jump statements | 1+ |

### Nesting Addition

Each level of nesting adds 1:

```python
# Level 0 - complexity 1
def process():
    pass

# Level 1 - complexity 2
def process():
    if condition:
        pass

# Level 2 - complexity 3  
def process():
    if condition:
        for item in items:
            pass
```

---

## Cyclomatic vs. Cognitive

| Code | Cyclomatic | Cognitive | Why |
|---|---|---|---|
| Deep recursion | Low | High | Hard to trace mentally |
| Switch statements | Medium | Low | Clear, organized |
| Arrow code | Low | High | Hard to follow |
| Exception handlers | Low | High | Need to track state |
| Mix of returns | Low | Medium | Where does execution go? |

### Example

```python
# Cyclomatic = 1 (no branches)
# Cognitive = 1 (linear)
def process(x):
    return x * 2

# Cyclomatic = 3 (2 branches)  
# Cognitive = 4 (nesting + breaks)
def process(x):
    if x > 0:
        if x > 10:
            for i in range(x):
                print(i)
        else:
            return x
    return 0
```

---

## Thresholds

| Cognitive Complexity | Interpretation |
|---|---|
| 0-15 | Low - easy to understand |
| 16-30 | Moderate - some mental effort required |
| 31-50 | High - difficult to follow |
| >50 | Very High - nearly impossible to understand |

---

## Remediation

1. **Flatten nesting**: Use guard clauses
2. **Extract methods**: Break into named pieces
3. **Remove unnecessary conditionals**: Simplify logic
4. **Reduce state tracking**: Don't make reader remember too much
5. **Name clearly**: Better names reduce cognitive load

---

## Tools

```bash
# SonarQube provides cognitive complexity
sonarqube analyze

# Gometrian for Go
go install github.com/elliotchance/gometrian/cmd/gometrian@latest
gometrian -complexity 15 .

# Python - radon supports cognitive
pip install radon
radon cc -s .
```

---

## Note

Cognitive complexity is about **human** understanding. Code may be machine-efficient but human-inefficient. Always consider the reader.