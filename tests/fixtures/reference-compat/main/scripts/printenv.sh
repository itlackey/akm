#!/bin/sh
# Prints the variables the corpus injects with --env / --secret.
for v in PLAIN TOKEN TEAM_KEY SHARED SCRIPT HOME_COPY SHELLISH TEAM_SECRET TEAM_ONLY MAIN_TOKEN MYTOK TK; do
  eval "val=\${$v-<unset>}"
  echo "$v=$val"
done
