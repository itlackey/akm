# Code Style: Formatting

Formatting and code layout standards.

## Principles

1. **Consistency**: Same code looks same everywhere
2. **Readability**: Easy to scan and understand
3. **Standard tools**: Use automated formatters

---

## Common Standards

### JavaScript/TypeScript

```typescript
// Prettier standard (2 spaces)
function calculateTotal(items: Item[]): number {
  return items.reduce((sum, item) => sum + item.price, 0);
}

// Arrow functions - concise for callbacks
const ids = items.map((item) => item.id);

// Object shorthand
const user = { name, email };  // vs { name: name, email: email }

// Trailing commas
const obj = {
  name: 'test',
  value: 42,  // trailing comma
};
```

### Python

```python
# PEP 8 (4 spaces)
def calculate_total(items):
    return sum(item['price'] for item in items)

# Line length - max 88 (Black formatter default)
def long_function_name(
    arg_one, arg_two, arg_three, arg_four
):
    # ...
```

---

## What to Check

| Aspect | Standard | Tools |
|---|---|---|
| Indentation | 2 or 4 spaces, consistent | Prettier, Black |
| Line length | 80-120 chars | ESLint, Black |
| Trailing whitespace | None | Editor config |
| Semicolons | Consistent (yes/no) | ESLint |
| Quotes | Single or double, consistent | Prettier |
| Brace style | K&R, Allman | ESLint |

---

## Import Organization

### Recommended Order (JavaScript/TypeScript)

```typescript
// 1. External libraries
import React from 'react';
import { useState } from 'react';
import axios from 'axios';

// 2. Internal packages
import { Button } from '@company/ui';
import { formatDate } from '@/utils';

// 3. Relative imports - same package
import { UserCard } from './components/UserCard';

// 4. Relative imports - parent
import { Types } from '../types';

// 5. Absolute imports (if used)
import '@/styles/global.css';
```

### Group by blank line:

```typescript
// External
import React from 'react';

// Internal
import { Button } from './Button';

// Relative - same level
import { UserCard } from './UserCard';
import { OrderList } from './OrderList';

// Relative - parent
import { types } from '../types';
```

---

## Common Formatting Issues

| Issue | Problem | Fix |
|---|---|---|
| Inconsistent indentation | Mixed tabs/spaces | Configure editor, use formatter |
| Long lines | Hard to read | Break into multiple lines |
| No blank lines | Dense code | Add blank lines between sections |
| Trailing spaces | Version control noise | Configure editor to strip |
| Inconsistent braces | Style inconsistency | Use formatter |

---

## Recommended Tools

| Language | Formatter | Linter |
|---|---|---|
| JS/TS | Prettier | ESLint |
| Python | Black | Ruff, Flake8 |
| Java | IntelliJ default | SpotBugs |
| Go | gofmt | golint |
| Rust | rustfmt | Clippy |

---

## IDE Configuration

```json
// .editorconfig (works in most editors)
root = true

[*]
indent_style = space
indent_size = 2
end_of_line = lf
charset = utf-8
trim_trailing_whitespace = true
insert_final_newline = true
```

---

## Test Your Formatting

```bash
# Check if code is formatted
npm run lint -- --fix  # ESLint with auto-fix
npx prettier --check .

# Python
black --check .
flake8 .
```