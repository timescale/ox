#!/bin/bash
branch="${1:-$(git branch --show-current)}"
remote_url=$(git remote get-url origin)

# Strip to just owner/repo
repo_path="${remote_url#https://github.com/}"
repo_path="${repo_path#git@github.com:}"
repo_path="${repo_path%.git}"

git push "https://x-access-token:${GH_TOKEN}@github.com/${repo_path}.git" "HEAD:${branch}"