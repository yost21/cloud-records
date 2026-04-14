#!/bin/bash
# Cloud Records backup wrapper for LaunchAgent.
# Usage: backup-cron.sh [metadata|full]
# - metadata: quick metadata-only backup (KB-scale), keeps last 4
# - full: complete audio + cover backup (~100MB), keeps last 12

set -e

MODE="${1:-metadata}"
PROJECT_DIR="/Users/chrisyost/music-platform"
BACKUP_DIR="$PROJECT_DIR/backups"
LOG_DIR="/Users/chrisyost/.hermes/logs"
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

mkdir -p "$LOG_DIR"
echo "[$TIMESTAMP] Starting $MODE backup" >> "$LOG_DIR/cloud-records-backup.log"

cd "$PROJECT_DIR"

if [ "$MODE" = "metadata" ]; then
  /opt/homebrew/bin/node backup.mjs --metadata >> "$LOG_DIR/cloud-records-backup.log" 2>&1 || {
    echo "[$TIMESTAMP] METADATA BACKUP FAILED" >> "$LOG_DIR/cloud-records-backup.log"
    exit 1
  }

  # Keep only the most recent 4 metadata-only backups (which are tiny dirs without audio/)
  cd "$BACKUP_DIR"
  ls -1dt cloud-records-* 2>/dev/null | while read dir; do
    if [ -d "$dir/audio" ] && [ "$(ls -A "$dir/audio" 2>/dev/null)" ]; then
      continue  # skip full backups
    fi
    echo "$dir"
  done | tail -n +5 | while read old; do
    echo "[$TIMESTAMP] Pruning old metadata backup: $old" >> "$LOG_DIR/cloud-records-backup.log"
    rm -rf "$old"
  done

elif [ "$MODE" = "full" ]; then
  /opt/homebrew/bin/node backup.mjs >> "$LOG_DIR/cloud-records-backup.log" 2>&1 || {
    echo "[$TIMESTAMP] FULL BACKUP FAILED" >> "$LOG_DIR/cloud-records-backup.log"
    exit 1
  }

  # Keep only the most recent 12 full backups
  cd "$BACKUP_DIR"
  ls -1dt cloud-records-* 2>/dev/null | while read dir; do
    if [ -d "$dir/audio" ] && [ "$(ls -A "$dir/audio" 2>/dev/null)" ]; then
      echo "$dir"
    fi
  done | tail -n +13 | while read old; do
    echo "[$TIMESTAMP] Pruning old full backup: $old" >> "$LOG_DIR/cloud-records-backup.log"
    rm -rf "$old"
  done

else
  echo "Usage: $0 [metadata|full]"
  exit 1
fi

echo "[$TIMESTAMP] $MODE backup complete" >> "$LOG_DIR/cloud-records-backup.log"
