# Cloud Records — Restore Procedure

Replays a `backup.mjs` manifest into a target canister via `restore.mjs`.

## What restores cleanly

- **Tracks** (audio + metadata) via `uploadChunk` + `finalizeTrack` — requires a full backup (not `--metadata`)
- **Cover art** via `setCoverArt` — requires a full backup
- **Featured flags** via `setFeatured`
- **Comments** via `addComment` — mints NEW comment IDs; old IDs are lost
- **Guestbook entries** via `addGuestbookEntry` — mints NEW entry IDs
- **Admins** via `addAdmin`

## What does NOT restore

| Lost | Why |
|---|---|
| Reply → comment linkage | `replyToComment` requires the parent comment ID, but comments get new IDs on replay. No backend method exists to restore replies against a specific (old) comment ID. Replies in the manifest are backed up but not replayed. |
| Play counts | No admin setter. `recordPlay` increments by 1 per call and requires a live listener principal. Counter values are analytics, not user-facing content — accepting loss. |
| Tomato counts | Same reason as play counts. |
| Track `createdAt` | `finalizeTrack` always sets `Time.now()`. Original upload times are not preserved. |
| Track `order` | `finalizeTrack` always assigns `trackCount` as the new order. The original ordering is not preserved. You can re-apply order post-restore via `setOrder` calls, but `restore.mjs` does not do this automatically. |
| Rate-limit / cooldown state | These are all ephemeral and don't need restoring. |
| W1.3 eviction companion state | Post-upgrade empty state, naturally rebuilds. |

## Usage

```bash
# 1. Create a backup first (writes to backups/cloud-records-<date>/)
node backup.mjs                # full backup, includes audio/ + covers/
node backup.mjs --metadata     # metadata only, no audio bytes

# 2. Dry-run the restore plan — parses the manifest, prints operation counts,
#    makes NO network calls. Safe to run anytime.
node restore.mjs backups/cloud-records-<date> --dry-run

# 3. Execute against a staging canister (fresh, empty)
node restore.mjs backups/cloud-records-<date> --target <staging-canister-id>

# 4. Metadata-only mode: skips tracks/covers/comments (all depend on tracks)
#    and only replays guestbook + admins. Use when chunk uploads would cost
#    cycles you don't have.
node restore.mjs backups/cloud-records-<date> --target <staging-canister-id> --metadata-only
```

## Safety interlocks

`restore.mjs` refuses to run in three cases:

1. **No `--dry-run` and no `--target`** — you must explicitly pick one. Prevents accidental fire-and-forget runs with a half-typed command.
2. **Target is a production canister** (`kfhms-uaaaa-aaaae-ageyq-cai` or `kmeho-ciaaa-aaaae-ageza-cai`) — requires `--yes-i-know-this-is-production` to override. Production restore is a disaster-recovery operation, not a routine one.
3. **Target canister already has tracks** — refuses unless `--append-over-existing` is passed. Forces you to restore into a known-empty staging canister.

## Prerequisites

- Target canister must be a fresh Motoko canister with the Cloud Records wasm installed.
- `chriscloud-admin` (or another admin) must be a controller of the target so `addAdmin(chriscloud-admin)` can bootstrap permissions.
- PEM at `~/.config/dfx/identity/chriscloud-admin/identity.pem` must be accessible.
- `DFX_WARNING=-mainnet_plaintext_identity` must be set if invoking dfx commands for the target (restore.mjs itself does not shell out to dfx).

## Typical disaster-recovery flow

1. Spin up a new canister (`dfx canister --network ic create cloud-records-recovery`)
2. Install the Cloud Records wasm (`dfx canister --network ic install ... --mode install`)
3. `node restore.mjs <latest-full-backup> --target <new-canister-id>`
4. Verify: `dfx canister --network ic call <new-canister-id> listTracks` returns all tracks
5. Verify: frontend points at the new canister ID (requires a `kmeho-…` redeploy with updated `VITE_CANISTER_ID_BACKEND` env var)
6. Optional: restore `order` values with a custom script that calls `setOrder` per track

## Known gotchas

- **`getAllReplies` is admin-gated.** The backup script loads the `chriscloud-admin` PEM if available; without it, the `replies` section of the manifest will be empty and a warning is printed. LaunchAgent backups already run with the PEM.
- **`--metadata` backups cannot restore tracks.** The audio files live in `backups/<date>/audio/`, which `backup.mjs --metadata` does not populate. Full backups are required for a complete restore.
- **Restored comments get new IDs.** Any links that referenced specific comment IDs pre-restore (e.g. share URLs, if they exist) will break.

## Validation

- Script logic verified via `restore.mjs --dry-run` against a real production metadata backup, 2026-04-15. Parses 35 tracks, 11 comments, 1 reply, 4 guestbook, 2 featured, 2 admins. Plan output matches manifest counts.
- Full-data dry-run against a restored staging canister is a **W6.1 hard gate** before the production video upgrade.
