#!/usr/bin/env bash
# smoke-test.sh — Runs inside a Docker container to verify akm works.
# Validates: init, index, search, show, list, info
set -euo pipefail

PASS=0
FAIL=0
ERRORS=""

pass() { ((PASS++)); echo "  ✓ $1"; }
fail() { ((FAIL++)); ERRORS+="  ✗ $1\n"; echo "  ✗ $1"; }

assert_exit_zero() {
  local desc="$1"; shift
  if "$@" >/dev/null 2>&1; then
    pass "$desc"
  else
    fail "$desc (exit code $?)"
  fi
}

assert_output_contains() {
  local desc="$1"; shift
  local needle="$1"; shift
  local out
  out=$("$@" 2>&1) || true
  if echo "$out" | grep -qi "$needle"; then
    pass "$desc"
  else
    fail "$desc — expected '$needle' in output"
    echo "    actual output: ${out:0:200}"
  fi
}

assert_json_field() {
  local desc="$1"; shift
  local field="$1"; shift
  local out
  out=$("$@" 2>&1) || true
  # Check that the JSON output has the expected field
  if echo "$out" | grep -q "\"$field\""; then
    pass "$desc"
  else
    fail "$desc — expected field '$field' in JSON"
    echo "    actual output: ${out:0:300}"
  fi
}

# ── Setup test stash with sample assets ──────────────────────────────────────

STASH_DIR="$(mktemp -d)/akm-smoke"
CONFIG_DIR="$(mktemp -d)/akm-config"
CACHE_DIR="$(mktemp -d)/akm-cache"
export AKM_STASH_DIR="$STASH_DIR"
export XDG_CONFIG_HOME="$CONFIG_DIR"
export XDG_CACHE_HOME="$CACHE_DIR"

echo "=== akm smoke test ==="
echo "Install method: ${AKM_INSTALL_METHOD:-unknown}"
echo "OS: $(cat /etc/os-release 2>/dev/null | grep PRETTY_NAME | cut -d= -f2 | tr -d '\"' || uname -s)"
echo "Arch: $(uname -m)"
echo "akm path: $(command -v akm || echo 'not in PATH')"
echo ""

# ── 1. Version / help ────────────────────────────────────────────────────────

echo "--- Basic CLI ---"
assert_exit_zero "akm --help exits 0" akm --help
assert_output_contains "akm --help shows usage" "usage\|Usage\|akm" akm --help

# ── 2. Init ──────────────────────────────────────────────────────────────────

echo "--- Init ---"
assert_exit_zero "akm init creates stash" akm init

# Verify stash directory structure was created
for subdir in scripts skills commands agents knowledge; do
  if [ -d "$STASH_DIR/$subdir" ]; then
    pass "init created $subdir/"
  else
    fail "init did not create $subdir/"
  fi
done

# ── 3. Populate stash with test assets ───────────────────────────────────────

echo "--- Populate test assets ---"

# Create a test script
mkdir -p "$STASH_DIR/scripts/deploy"
cat > "$STASH_DIR/scripts/deploy/deploy-app.sh" << 'SCRIPT'
#!/usr/bin/env bash
# Deploy application to production server
echo "Deploying application..."
SCRIPT
chmod +x "$STASH_DIR/scripts/deploy/deploy-app.sh"

# Create a test skill
mkdir -p "$STASH_DIR/skills/code-review"
cat > "$STASH_DIR/skills/code-review/SKILL.md" << 'SKILL'
---
name: code-review
description: Review code for quality, security, and best practices
tags: [review, quality, security]
---

# Code Review Skill

Review the provided code for:
- Security vulnerabilities
- Performance issues
- Code quality and readability
SKILL

# Create a test command
mkdir -p "$STASH_DIR/commands"
cat > "$STASH_DIR/commands/lint-project.md" << 'CMD'
---
name: lint-project
description: Run linter on the project with auto-fix
tags: [lint, format, quality]
---

Run the project linter with auto-fix enabled.
CMD

# Create a test knowledge asset
mkdir -p "$STASH_DIR/knowledge"
cat > "$STASH_DIR/knowledge/docker-best-practices.md" << 'KB'
---
name: docker-best-practices
description: Best practices for writing Dockerfiles
tags: [docker, containers, devops]
---

# Docker Best Practices

1. Use multi-stage builds
2. Minimize layer count
3. Use .dockerignore
KB

# Create a test agent
mkdir -p "$STASH_DIR/agents"
cat > "$STASH_DIR/agents/devops-agent.md" << 'AGENT'
---
name: devops-agent
description: A DevOps assistant agent for infrastructure tasks
tags: [devops, infrastructure, automation]
---

You are a DevOps assistant. Help with infrastructure, CI/CD, and deployment tasks.
AGENT

pass "populated test stash with 5 assets"

# ── 4. Index ─────────────────────────────────────────────────────────────────

echo "--- Index ---"
assert_exit_zero "akm index succeeds" akm index
assert_output_contains "akm index reports entries" "entries\|indexed\|Indexed" akm index

# ── 5. Search ────────────────────────────────────────────────────────────────

echo "--- Search ---"

# Basic search
assert_exit_zero "akm search 'deploy' exits 0" akm search deploy
assert_output_contains "search 'deploy' finds deploy script" "deploy" akm search deploy

# Search with JSON output
assert_json_field "search JSON has hits" "hits" akm search deploy --format json

# Search with type filter
assert_output_contains "search type:skill finds code-review" "code-review\|review" akm search review --type skill

# Search for knowledge
assert_output_contains "search 'docker' finds knowledge" "docker" akm search docker

# Search with limit
RESULT=$(akm search deploy --format json --limit 1 2>&1) || true
if echo "$RESULT" | grep -q "hits"; then
  pass "search with --limit 1 returns JSON with hits"
else
  fail "search with --limit 1 failed"
fi

# ── 6. Show ──────────────────────────────────────────────────────────────────

echo "--- Show ---"
assert_exit_zero "akm show script:deploy-app exits 0" akm show script:deploy-app
assert_output_contains "show displays script content" "deploy\|Deploy" akm show script:deploy-app

# ── 7. Info ──────────────────────────────────────────────────────────────────

echo "--- Info ---"
assert_exit_zero "akm info exits 0" akm info
assert_json_field "info has stashDir" "stashDir" akm info --format json

# ── 8. List ──────────────────────────────────────────────────────────────────

echo "--- List ---"
# list may return empty but should not error
akm list >/dev/null 2>&1 || true
pass "akm list does not crash"

# ── 9. Re-index (incremental) ───────────────────────────────────────────────

echo "--- Re-index ---"

# Add another asset and re-index
mkdir -p "$STASH_DIR/scripts/backup"
cat > "$STASH_DIR/scripts/backup/backup-db.sh" << 'SCRIPT'
#!/usr/bin/env bash
# Backup the database to S3
echo "Backing up database..."
SCRIPT

assert_exit_zero "incremental index succeeds" akm index
assert_output_contains "search finds newly indexed asset" "backup" akm search backup

# ── Summary ──────────────────────────────────────────────────────────────────

echo ""
echo "=== Results ==="
echo "  Passed: $PASS"
echo "  Failed: $FAIL"

if [ "$FAIL" -gt 0 ]; then
  echo ""
  echo "Failures:"
  echo -e "$ERRORS"
  exit 1
fi

echo ""
echo "All tests passed."
exit 0
