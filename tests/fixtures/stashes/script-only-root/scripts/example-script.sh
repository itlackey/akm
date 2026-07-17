#!/usr/bin/env bash
# Golden-root fixture for the script adapter's looksLikeRoot conformance gate
# (chunk-2 WI-2.1, D2-6). Single-adapter root: this stash contains ONLY a
# scripts/ directory, so the script adapter's looksLikeRoot must fire here
# and every sibling adapter's (skill/wiki) looksLikeRoot must not.
exit 0
