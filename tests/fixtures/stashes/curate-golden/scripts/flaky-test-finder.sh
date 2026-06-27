#!/usr/bin/env bash
# Re-run the suite many times to surface flaky tests
for i in $(seq 1 50); do bun test || break; done
