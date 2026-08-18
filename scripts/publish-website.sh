#!/usr/bin/env bash

set -Eeuo pipefail

readonly remote_name="origin"
readonly pages_branch="gh-pages"

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
repo_root="$(git -C "$repo_root" rev-parse --show-toplevel)"
website_dir="$repo_root/website"

if [[ ! -d "$website_dir" ]]; then
  echo "Error: website directory not found: $website_dir" >&2
  exit 1
fi

if ! git -C "$repo_root" remote get-url "$remote_name" >/dev/null 2>&1; then
  echo "Error: Git remote '$remote_name' is not configured." >&2
  exit 1
fi

echo "Fetching $remote_name/$pages_branch ..."
if ! git -C "$repo_root" fetch --prune "$remote_name" \
  "refs/heads/$pages_branch:refs/remotes/$remote_name/$pages_branch"; then
  echo "Error: could not fetch $remote_name/$pages_branch." >&2
  exit 1
fi

if ! git -C "$repo_root" show-ref --verify --quiet "refs/remotes/$remote_name/$pages_branch"; then
  echo "Error: remote branch $remote_name/$pages_branch does not exist." >&2
  exit 1
fi

# Keep the local branch aligned with the remote before creating the temporary
# worktree. Diverged or unpublished local gh-pages commits are never discarded.
if ! git -C "$repo_root" show-ref --verify --quiet "refs/heads/$pages_branch"; then
  git -C "$repo_root" branch "$pages_branch" "$remote_name/$pages_branch"
elif ! git -C "$repo_root" merge-base --is-ancestor "$pages_branch" "$remote_name/$pages_branch"; then
  echo "Error: local $pages_branch has commits not present on $remote_name/$pages_branch." >&2
  echo "Push or reconcile that branch manually before publishing the website." >&2
  exit 1
elif [[ "$(git -C "$repo_root" rev-parse "$pages_branch")" != "$(git -C "$repo_root" rev-parse "$remote_name/$pages_branch")" ]]; then
  git -C "$repo_root" branch -f "$pages_branch" "$remote_name/$pages_branch"
fi

worktree_dir="$(mktemp -d "${TMPDIR:-/tmp}/texlite-website.XXXXXX")"

cleanup() {
  local exit_code=$?

  if [[ -n "${worktree_dir:-}" ]]; then
    git -C "$repo_root" worktree remove --force "$worktree_dir" >/dev/null 2>&1 || true
    if [[ -e "$worktree_dir" ]]; then
      rm -rf -- "$worktree_dir"
    fi
  fi

  exit "$exit_code"
}

trap cleanup EXIT

echo "Preparing temporary worktree ..."
git -C "$repo_root" worktree add "$worktree_dir" "$pages_branch" >/dev/null

# gh-pages is a generated branch: remove its previous generated contents, then
# copy only the checked-in website source from the current working tree.
git -C "$worktree_dir" clean -fdx >/dev/null
cp -a "$website_dir/." "$worktree_dir/"
touch "$worktree_dir/.nojekyll"

git -C "$worktree_dir" add -A
if git -C "$worktree_dir" diff --cached --quiet; then
  echo "Website is already up to date; nothing to commit."
  exit 0
fi

git -C "$worktree_dir" commit -m "update website" >/dev/null
git -C "$worktree_dir" push "$remote_name" "$pages_branch"
echo "Website published to $remote_name/$pages_branch."
