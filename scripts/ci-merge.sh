#!/usr/bin/env bash
# Integrator helper: merge every agent branch that has new commits into main.
# package.json conflicts keep both sides' scripts; generated results files keep the branch's copy,
# except headline/usage/config which main owns. Anything else unresolved aborts that merge.
# Usage: bash scripts/ci-merge.sh <path-to-merge-pkg.mjs>
set -u
S="$1"
merged=""
for b in $(git branch --format='%(refname:short)' | grep -E '^p[0-9]+$'); do
  [ "$(git rev-list --count "main..$b")" = "0" ] && continue
  git merge --no-ff --no-commit -q "$b" > /dev/null 2>&1
  bad=""
  for f in $(git diff --name-only --diff-filter=U); do
    case "$f" in
      package.json) node "$S" "$b" > /dev/null && git add package.json ;;
      results/headline.json|results/usage.json|results/deck_numbers.txt|config/default.json) git checkout --ours "$f" 2>/dev/null && git add "$f" ;;
      results/*|data/*) git checkout --theirs "$f" 2>/dev/null && git add "$f" ;;
      *) bad="$bad $f" ;;
    esac
  done
  if [ -n "$bad" ]; then
    echo "ABORTED merge of $b: unresolved$bad"
    git merge --abort
    continue
  fi
  if [ -f .git/MERGE_HEAD ]; then
    git commit -q --no-edit -m "Merge branch '$b' (continuous integration)

Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>" && merged="$merged $b"
  fi
done
echo "merged:${merged:- none}"
