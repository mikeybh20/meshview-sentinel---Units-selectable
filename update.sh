#!/usr/bin/env bash
# MeshView Sentinel — one-shot updater.
#
# Pulls the current branch from origin and rebuilds the Docker containers.
# Designed to be the simple "I just want the latest" path operators can run
# from anywhere in the repo. Defaults work for the common case; flags exist
# for the edge cases.
#
# Usage:
#   ./update.sh                 # pull current branch, rebuild meshview
#   ./update.sh --branch main   # pull main instead of the current branch
#   ./update.sh --dry-run       # show what would change without doing it
#   ./update.sh --skip-build    # pull + restart without rebuilding (rarely useful)
#   ./update.sh --skip-restart  # pull + rebuild, but don't bounce the container
#   ./update.sh --help          # this message
#
# What it does NOT touch:
#   - The named Docker volume `meshview-data` (your SQLite DB lives here).
#     Survives every rebuild. To migrate that, use Settings → Data → Full
#     Backup in the dashboard.
#   - Your `.env` (gitignored — never overwritten by pulls).
#   - Local commits ahead of origin (the pull is fast-forward only; the
#     script aborts if your branch has diverged and tells you what to do).
#
# Exit codes:
#   0  success
#   1  generic preflight failure (not in a git repo, missing docker, etc.)
#   2  uncommitted local changes that would block the pull
#   3  branch has diverged from origin (manual intervention needed)
#   4  docker compose failed during rebuild
set -euo pipefail

# -------------------------------------------------------------------------
# Colors — only when stdout is a TTY so logs piped to files stay clean.
# -------------------------------------------------------------------------
if [[ -t 1 ]]; then
  C_RESET=$'\e[0m'
  C_BOLD=$'\e[1m'
  C_DIM=$'\e[2m'
  C_RED=$'\e[31m'
  C_GREEN=$'\e[32m'
  C_YELLOW=$'\e[33m'
  C_BLUE=$'\e[34m'
  C_CYAN=$'\e[36m'
else
  C_RESET=''; C_BOLD=''; C_DIM=''; C_RED=''; C_GREEN=''; C_YELLOW=''; C_BLUE=''; C_CYAN=''
fi

say() { printf '%s\n' "$*"; }
header() { say "${C_BOLD}${C_CYAN}» $*${C_RESET}"; }
info() { say "${C_DIM}  $*${C_RESET}"; }
ok() { say "${C_GREEN}✓ $*${C_RESET}"; }
warn() { say "${C_YELLOW}! $*${C_RESET}"; }
err() { say "${C_RED}✗ $*${C_RESET}" 1>&2; }

# -------------------------------------------------------------------------
# CD into the repo root so relative paths (docker-compose.yml) work no
# matter where the operator ran the script from.
# -------------------------------------------------------------------------
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_ROOT"

# -------------------------------------------------------------------------
# Args
# -------------------------------------------------------------------------
BRANCH=""
SKIP_BUILD=0
SKIP_RESTART=0
DRY_RUN=0

usage() {
  sed -n '2,/^set -/p' "$0" | sed 's/^# \{0,1\}//' | sed '$d'
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --branch)
      BRANCH="${2-}"
      [[ -z "$BRANCH" ]] && { err "--branch needs a value"; exit 1; }
      shift 2
      ;;
    --branch=*) BRANCH="${1#--branch=}"; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    --skip-restart) SKIP_RESTART=1; shift ;;
    --help|-h) usage ;;
    *) err "Unknown flag: $1"; say "Run with --help for usage."; exit 1 ;;
  esac
done

# -------------------------------------------------------------------------
# Preflight
# -------------------------------------------------------------------------
header "Preflight"

if ! command -v git >/dev/null 2>&1; then
  err "git not found in PATH"; exit 1
fi
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  err "Not inside a git repository (cwd: $REPO_ROOT)"; exit 1
fi
if [[ ! -f docker-compose.yml ]]; then
  err "docker-compose.yml not found in $REPO_ROOT"; exit 1
fi

# Detect docker compose flavor — prefer `docker compose` (plugin) over the
# legacy `docker-compose` binary. Both work; modern Docker installs ship
# the plugin only.
DC=""
if docker compose version >/dev/null 2>&1; then
  DC="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  DC="docker-compose"
else
  err "Neither 'docker compose' nor 'docker-compose' is available"; exit 1
fi
info "Docker compose driver: $DC"

# Resolve the branch we'll be pulling. Default = current branch.
CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [[ -z "$BRANCH" ]]; then BRANCH="$CURRENT_BRANCH"; fi
info "Branch: $BRANCH (currently on $CURRENT_BRANCH)"

# Refuse to clobber uncommitted local work. `git pull --ff-only` would
# refuse too, but this gives a clearer message + clean exit code.
if [[ -n "$(git status --porcelain)" ]]; then
  err "You have uncommitted local changes."
  say "  Either commit / stash them, or run \`git stash push\` first."
  say "  Files changed:"
  git status --short | sed 's/^/    /'
  exit 2
fi

# -------------------------------------------------------------------------
# Fetch + show what's coming
# -------------------------------------------------------------------------
header "Fetching origin/$BRANCH"
git fetch --tags origin "$BRANCH"

# Pulling against the named ref so this still works if HEAD is detached.
LOCAL_SHA="$(git rev-parse HEAD)"
REMOTE_SHA="$(git rev-parse "origin/$BRANCH")"

if [[ "$LOCAL_SHA" == "$REMOTE_SHA" ]]; then
  ok "Already at origin/$BRANCH — no updates."
  info "($LOCAL_SHA)"
  # Continue to rebuild anyway if the operator explicitly asked for one;
  # most of the time they didn't, and there's nothing to do.
  if [[ $SKIP_BUILD -eq 1 ]]; then
    info "Nothing to do."; exit 0
  fi
  # Still rebuild — image cache may be stale even when source isn't.
  warn "Code is current. Rebuilding anyway to refresh the image."
else
  # Verify the local branch can be fast-forwarded. If LOCAL_SHA isn't an
  # ancestor of REMOTE_SHA, we've diverged — operator needs to resolve.
  if ! git merge-base --is-ancestor "$LOCAL_SHA" "$REMOTE_SHA"; then
    err "Local $CURRENT_BRANCH has diverged from origin/$BRANCH."
    say "  Local has commits that aren't upstream. Choose one:"
    say "    1. Push them:    ${C_BOLD}git push origin $CURRENT_BRANCH${C_RESET}"
    say "    2. Reset hard:   ${C_BOLD}git reset --hard origin/$BRANCH${C_RESET}  ${C_RED}(loses local commits)${C_RESET}"
    say "    3. Rebase:       ${C_BOLD}git rebase origin/$BRANCH${C_RESET}"
    say "  Local commits not in origin:"
    git log --oneline "origin/$BRANCH..HEAD" | sed 's/^/    /'
    exit 3
  fi

  AHEAD_BY="$(git rev-list --count "HEAD..origin/$BRANCH")"
  header "Incoming ($AHEAD_BY commit(s))"
  git --no-pager log --oneline "HEAD..origin/$BRANCH"
fi

# -------------------------------------------------------------------------
# Dry-run exit
# -------------------------------------------------------------------------
if [[ $DRY_RUN -eq 1 ]]; then
  warn "--dry-run: stopping here."
  exit 0
fi

# -------------------------------------------------------------------------
# Pull (fast-forward only — diverged case already handled above)
# -------------------------------------------------------------------------
if [[ "$LOCAL_SHA" != "$REMOTE_SHA" ]]; then
  header "Pulling"
  git pull --ff-only origin "$BRANCH"
  ok "Pulled to $(git rev-parse HEAD | cut -c1-12)"
fi

# -------------------------------------------------------------------------
# Rebuild + restart
# -------------------------------------------------------------------------
if [[ $SKIP_BUILD -eq 1 && $SKIP_RESTART -eq 1 ]]; then
  ok "Done (skipped build + restart per flags)."
  exit 0
fi

if [[ $SKIP_BUILD -eq 0 ]]; then
  header "Rebuilding meshview container"
  if ! $DC build meshview; then
    err "Docker build failed."; exit 4
  fi
  ok "Build complete."
fi

if [[ $SKIP_RESTART -eq 0 ]]; then
  header "Restarting"
  if ! $DC up -d meshview; then
    err "Docker compose up failed."; exit 4
  fi
  ok "Container up."
fi

# -------------------------------------------------------------------------
# Post-state summary
# -------------------------------------------------------------------------
header "Status"
$DC ps meshview || true

say ""
ok "Update complete."
info "Dashboard: ${C_BOLD}http://$(hostname -I 2>/dev/null | awk '{print $1}'):3000${C_RESET}"
info "Logs:      ${C_BOLD}$DC logs -f meshview${C_RESET}"
