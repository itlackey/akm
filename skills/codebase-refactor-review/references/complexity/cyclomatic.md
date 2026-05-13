# Complexity: Cyclomatic

Understanding and calculating cyclomatic complexity.

## Definition

Cyclomatic Complexity (CC) measures the number of linearly independent execution paths through code. It indicates how hard code is to test, understand, and maintain.

**Formula**: `CC = E - N + 2P`

Where:
- E = edges (lines with arrows)
- N = nodes (program statements)
- P = connected components (usually 1 for single function)

**Simpler formula**: `CC = number of decision points + 1`

---

## Decision Points

Each of these adds 1 to complexity:

| Decision Point | Example |
|---|---|
| `if` statement | `if (x > 0)` |
| `else` clause | `else { ... }` (already counted in if) |
| `case`/`switch` | Each case adds 1 |
| `for` loop | Each loop adds 1 |
| `while` loop | Each while adds 1 |
| `do-while` loop | Each do adds 1 |
| `&&` operator | Short-circuit AND |
| `||` operator | Short-circuit OR |
| `? :` ternary | Conditional operator |

---

## Thresholds

| Complexity | Risk Level | Action |
|---|---|---|
| 1-10 | Low | Simple, well-structured |
| 11-20 | Moderate | Moderate risk, consider refactoring |
| 21-50 | High | Complex, high risk, refactor strongly |
| >50 | Very High | Very complex, rewrite recommended |

**Note**: These are guidelines. Domain knowledge and test coverage matter.

---

## Examples

### Low Complexity (CC = 3)

```python
def process(data):
    if data.is_valid:              # +1
        return transform(data)    # no decision
    else:
        return None               # no decision
```

### High Complexity (CC = 12+)

```python
def process_order(order):
    if order.status == 'pending':           # +1
        if order.payment:                   # +1
            if order.items:                 # +1
                for item in order.items:    # +1
                    if item.in_stock:       # +1 (per iteration)
                        if item.shippable:  # +1 (per iteration)
                            pass
    
    if order.customer:                      # +1
        if order.customer.verified:        # +1
            pass
    
    return order
```

---

## Why It Matters

| Complexity | Impact |
|---|---|
| Testing | Each path needs test case. CC=10 needs ~10 test cases minimum |
| Maintainability | More paths = harder to understand changes |
| Debugging | Harder to trace through branches |
| Risk | More paths = more places for bugs |

---

## How to Measure

### Manual Count
1. Count decision points
2. Add 1

### Tools

```bash
# JavaScript/TypeScript
npm install -g complexity-report
complexity src/

# Python
pip install radon
radon cc -a .

# Java
pmd cpd --minimum-tokens 50

# All: use your linter
eslint --max-complexity 10
```

### IDE Plugins
- VS Code: "ESLint", "SonarLint"
- IntelliJ: "Structural Search and Inspection"

---

## Remediation

1. **Extract methods**: Split complex functions
2. **Early returns**: Guard clauses reduce nesting
3. **Switch to patterns**: Strategy, State, Table-driven
4. **Reduce parameters**: Use objects instead of primitives
5. **Remove dead code**: Eliminate unreachable paths