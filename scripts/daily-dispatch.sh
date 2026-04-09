#!/bin/bash
# Daily dispatch trigger for Open Brain tasks.
#
# Runs `claude` headlessly with a prompt that walks the Open Brain task
# queue via the Open Brain MCP. No Docker, no Supabase webhook, no
# tunnel — just Claude using the MCP tools it already has configured.
#
# Scheduled by ~/Library/LaunchAgents/com.openbrain.dailydispatch.plist
# at 01:00 local time.

set -u
# launchd does not inherit a useful environment — hardcode HOME and PATH
# so subprocesses (claude, git, ssh, etc.) behave like an interactive shell.
export HOME="/Users/atorenherrinton"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
LOG="$HOME/Library/Logs/open-brain-dispatch.log"
CLAUDE_BIN="$HOME/.local/bin/claude"

mkdir -p "$(dirname "$LOG")"
exec >>"$LOG" 2>&1
echo
echo "=== $(date '+%Y-%m-%d %H:%M:%S %Z') daily-dispatch start ==="

if [ ! -x "$CLAUDE_BIN" ]; then
  echo "ERROR: claude binary not found at $CLAUDE_BIN"
  exit 1
fi

read -r -d '' PROMPT <<'EOF'
You are the Open Brain daily task dispatcher. Work through the task queue
using the Open Brain MCP tools that are already configured for you.

Procedure:

1. Call list_tasks to get tasks with status "todo" or "in_progress".
   Sort by priority then due_date. Process them one at a time.

2. For each task:
   a. Read the task title + description carefully. Figure out which repo
      under ~/Documents/GitHub the task is about. If the task has a
      project_id, call get_project to see if the project name/description
      points at a specific repo. If you cannot confidently identify a
      single repo from the task content, SKIP the task: add a task note
      explaining the ambiguity and move on. Do NOT guess.
   b. cd into that repo.
   c. Do the work.
   d. Commit your changes with a clear message.
   e. Push to the remote.
   f. VERIFY the push landed: run `git rev-parse HEAD` and
      `git ls-remote origin <current-branch>` and confirm the remote
      contains your commit SHA. If verification fails, do NOT mark the
      task done — add a task note describing what happened and move on.
   g. Only after the push is verified, call update_task to mark status
      "done" and add a task note summarizing what you changed.

3. If a task is ambiguous, blocked, or needs human input: leave it in its
   current status, add a task note explaining the blocker, and move to
   the next one. Do not invent requirements.

4. Stop when there are no more todo or in_progress tasks to process.

5. At the end, print a one-line summary: how many tasks completed, how
   many skipped, how many blocked.

Be efficient — this is a batch run, not an interactive session.
EOF

echo "Invoking claude..."
cd "$HOME/Documents/GitHub" || { echo "ERROR: cannot cd to GitHub root"; exit 1; }
# Pipe the prompt via stdin instead of as a positional arg — `--add-dir`
# is variadic so a trailing positional gets eaten as another directory.
printf '%s\n' "$PROMPT" | "$CLAUDE_BIN" \
  --add-dir "$HOME/Documents/GitHub" \
  --model claude-opus-4-6 \
  --permission-mode bypassPermissions \
  --print
status=$?
echo
echo "=== done (exit $status) ==="
