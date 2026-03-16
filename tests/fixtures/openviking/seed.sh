#!/usr/bin/env bash
# Seed the OpenViking server with test content.
# Run after `docker compose up -d` has started.
#
# Usage: ./seed.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
CONTENT_DIR="$SCRIPT_DIR/content"
WORKSPACE_DIR="$REPO_ROOT/.dev/workspace"

BASE="http://localhost:1933/api/v1"
AUTH="Authorization: Bearer akm-test-key"
CT="Content-Type: application/json"

echo "Waiting for OpenViking to be healthy..."
for i in $(seq 1 30); do
  if curl -sf "http://localhost:1933/health" > /dev/null 2>&1; then
    echo "Server is up."
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "Timed out waiting for server."
    exit 1
  fi
  sleep 1
done

# Copy seed content into the workspace so the container can access it
echo ""
echo "=== Copying seed content to workspace ==="
for subdir in memories resources; do
  if [ -d "$CONTENT_DIR/$subdir" ]; then
    mkdir -p "$WORKSPACE_DIR/$subdir"
    cp -v "$CONTENT_DIR/$subdir/"*.md "$WORKSPACE_DIR/$subdir/"
  fi
done

echo ""
echo "=== Seeding resources ==="

for file in api-reference project-context coding-standards; do
  echo "  Adding resource: $file"
  container_path="/workspace/resources/${file}.md"
  curl -s -X POST "$BASE/resources" \
    -H "$AUTH" -H "$CT" \
    -d "{\"path\":\"${container_path}\",\"reason\":\"test fixture\",\"wait\":true,\"timeout\":30}" \
    | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'    -> {d.get(\"result\",{}).get(\"root_uri\",\"error\")}')" 2>/dev/null \
    || echo "    -> (already exists or error)"
done

echo ""
echo "=== Seeding memories ==="

for file in project-context; do
  echo "  Adding memory: $file"
  container_path="/workspace/memories/${file}.md"
  curl -s -X POST "$BASE/resources" \
    -H "$AUTH" -H "$CT" \
    -d "{\"path\":\"${container_path}\",\"reason\":\"test fixture\",\"wait\":true,\"timeout\":30}" \
    | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'    -> {d.get(\"result\",{}).get(\"root_uri\",\"error\")}')" 2>/dev/null \
    || echo "    -> (already exists or error)"
done

echo ""
echo "=== Verifying ==="

echo "Resources:"
curl -s "$BASE/fs/ls?uri=viking://resources" -H "$AUTH" \
  | python3 -c "
import sys,json
d=json.load(sys.stdin)
for item in d.get('result',[]):
  print(f'  {item[\"uri\"]}  (dir={item[\"isDir\"]})')
" 2>/dev/null || echo "  (empty)"

echo ""
echo "Content read test:"
curl -s "$BASE/content/read?uri=viking://resources/project-context/project-context.md&offset=0&limit=-1" -H "$AUTH" \
  | python3 -c "
import sys,json
d=json.load(sys.stdin)
content = d.get('result','')
lines = content.strip().split('\n')[:3]
for line in lines:
  print(f'  {line}')
if len(content.strip().split('\n')) > 3:
  print('  ...')
" 2>/dev/null || echo "  (failed)"

echo ""
echo "Done. Test with:"
echo "  akm stash add http://localhost:1933 --provider openviking --name openviking"
echo "  akm show viking://resources/project-context/project-context.md"
