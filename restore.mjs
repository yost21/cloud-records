#!/usr/bin/env node
/**
 * Cloud Records Restore Script
 *
 * Replays a backup manifest into a target canister. Complements backup.mjs.
 *
 * MODES:
 *   --dry-run                      Parse manifest, print plan, NO network calls
 *   --target <canister-id>         Execute the plan against the given canister
 *   --metadata-only                With --target: skip chunk uploads + anything
 *                                  that depends on track existence. Only
 *                                  guestbook + admin list get replayed.
 *                                  Without --target: implies --dry-run.
 *
 * Without --target OR --dry-run, the script refuses to run (prevents
 * accidentally pointing at production).
 *
 * SCOPE OF RESTORE (full mode, with chunk upload):
 *   ✅ Tracks              via finalizeTrack (new createdAt/order assigned)
 *   ✅ Audio chunks        via uploadChunk from <backup>/audio/
 *   ✅ Cover art           via setCoverArt from <backup>/covers/
 *   ✅ Featured flags      via setFeatured
 *   ✅ Comments            via addComment (NEW comment IDs minted)
 *   ✅ Guestbook entries   via addGuestbookEntry (NEW entry IDs minted)
 *   ✅ Admins              via addAdmin
 *   ⚠️  Replies            SKIPPED — require old→new comment ID remapping
 *                          (not implementable without a backend restoreReply
 *                          method that takes an explicit commentId).
 *   ⚠️  Play counts        SKIPPED — no admin API to set a counter; recordPlay
 *                          increments by 1 and requires a valid principal.
 *   ⚠️  Tomato counts      SKIPPED — same as play counts.
 *   ⚠️  createdAt / order  NOT PRESERVED — finalizeTrack mints fresh values.
 *
 * Usage:
 *   node restore.mjs backups/cloud-records-2026-04-15 --dry-run
 *   node restore.mjs backups/cloud-records-2026-04-15 --target <canister-id>
 *   node restore.mjs backups/cloud-records-2026-04-15 --target <canister-id> --metadata-only
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url + '/../frontend/');
const { Actor, HttpAgent } = require('@dfinity/agent');
const { Principal } = require('@dfinity/principal');
const { Secp256k1KeyIdentity } = require('@dfinity/identity-secp256k1');
import { readFileSync, existsSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';

// ── Args ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const positional = args.filter(a => !a.startsWith('--'));
const BACKUP_DIR = positional[0];
const DRY_RUN = args.includes('--dry-run');
const METADATA_ONLY = args.includes('--metadata-only');
const targetIdx = args.indexOf('--target');
const TARGET_CANISTER = targetIdx >= 0 ? args[targetIdx + 1] : undefined;

if (!BACKUP_DIR) {
  console.error('Usage: node restore.mjs <backup-dir> [--dry-run] [--target <canister-id>] [--metadata-only]');
  process.exit(1);
}

if (!DRY_RUN && !TARGET_CANISTER) {
  console.error('ERROR: must specify either --dry-run or --target <canister-id>');
  console.error('Refusing to run without an explicit target to prevent accidental production writes.');
  process.exit(1);
}

// Safety interlock: never allow --target kfhms-... without an extra ack flag.
const PRODUCTION_CANISTERS = ['kfhms-uaaaa-aaaae-ageyq-cai', 'kmeho-ciaaa-aaaae-ageza-cai'];
if (TARGET_CANISTER && PRODUCTION_CANISTERS.includes(TARGET_CANISTER) && !args.includes('--yes-i-know-this-is-production')) {
  console.error(`ERROR: target ${TARGET_CANISTER} is a production canister.`);
  console.error('Restore to production requires --yes-i-know-this-is-production. Refusing.');
  process.exit(1);
}

// ── IDL ─────────────────────────────────────────────────────────────────
const idlFactory = ({ IDL }) => {
  const TrackInfo = IDL.Record({
    id: IDL.Text, name: IDL.Text, artist: IDL.Text, album: IDL.Text,
    trackNumber: IDL.Nat, mimeType: IDL.Text, totalChunks: IDL.Nat,
    size: IDL.Nat, createdAt: IDL.Int, order: IDL.Nat, coverArtType: IDL.Text,
    featured: IDL.Bool,
  });
  const Comment = IDL.Record({
    id: IDL.Text, author: IDL.Text, text: IDL.Text, createdAt: IDL.Int,
  });
  const GuestbookEntry = IDL.Record({
    id: IDL.Text, author: IDL.Text, text: IDL.Text, createdAt: IDL.Int,
  });
  return IDL.Service({
    uploadChunk       : IDL.Func([IDL.Text, IDL.Nat, IDL.Vec(IDL.Nat8)], [], []),
    finalizeTrack     : IDL.Func([IDL.Text, IDL.Text, IDL.Text, IDL.Text, IDL.Nat, IDL.Nat, IDL.Text, IDL.Nat], [], []),
    setCoverArt       : IDL.Func([IDL.Text, IDL.Vec(IDL.Nat8), IDL.Text], [], []),
    setFeatured       : IDL.Func([IDL.Text, IDL.Bool], [], []),
    addComment        : IDL.Func([IDL.Text, IDL.Text, IDL.Text], [], []),
    addGuestbookEntry : IDL.Func([IDL.Text, IDL.Text], [], []),
    addAdmin          : IDL.Func([IDL.Principal], [], []),
    listTracks        : IDL.Func([], [IDL.Vec(TrackInfo)], ['query']),
    getGuestbook      : IDL.Func([], [IDL.Vec(GuestbookEntry)], ['query']),
  });
};

// ── Helpers ─────────────────────────────────────────────────────────────
const CHUNK_SIZE = 1_900_000;
const ADMIN_PEM_PATH = join(homedir(), '.config/dfx/identity/chriscloud-admin/identity.pem');

function reviveBigInts(obj) {
  // backup.mjs writes BigInts as strings via bigIntReplacer. We parse them
  // back into BigInts for IDL.Nat / IDL.Int fields.
  if (obj && typeof obj === 'object') {
    if (Array.isArray(obj)) return obj.map(reviveBigInts);
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      // Field-specific revival
      if (['trackNumber', 'totalChunks', 'size', 'order'].includes(k) && typeof v === 'string') {
        out[k] = BigInt(v);
      } else if (['createdAt'].includes(k) && typeof v === 'string') {
        out[k] = BigInt(v);
      } else {
        out[k] = reviveBigInts(v);
      }
    }
    return out;
  }
  return obj;
}

function loadManifest(backupDir) {
  const path = join(backupDir, 'manifest.json');
  if (!existsSync(path)) {
    throw new Error(`Manifest not found: ${path}`);
  }
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  return reviveBigInts(raw);
}

function findAudioFile(backupDir, trackId) {
  const audioDir = join(backupDir, 'audio');
  if (!existsSync(audioDir)) return null;
  const files = readdirSync(audioDir);
  const match = files.find(f => f.startsWith(trackId + '.'));
  return match ? join(audioDir, match) : null;
}

function findCoverFile(backupDir, trackId) {
  const coverDir = join(backupDir, 'covers');
  if (!existsSync(coverDir)) return null;
  const files = readdirSync(coverDir);
  const match = files.find(f => f.startsWith(trackId + '.'));
  return match ? join(coverDir, match) : null;
}

function extToMime(path) {
  if (path.endsWith('.mp3')) return 'audio/mpeg';
  if (path.endsWith('.m4a')) return 'audio/mp4';
  if (path.endsWith('.wav')) return 'audio/wav';
  if (path.endsWith('.ogg')) return 'audio/ogg';
  if (path.endsWith('.flac')) return 'audio/flac';
  if (path.endsWith('.png')) return 'image/png';
  if (path.endsWith('.jpg') || path.endsWith('.jpeg')) return 'image/jpeg';
  if (path.endsWith('.webp')) return 'image/webp';
  return 'application/octet-stream';
}

// ── Plan builder ────────────────────────────────────────────────────────
function buildPlan(manifest, backupDir, metadataOnly) {
  const plan = {
    trackUploads     : [],  // { track, audioPath, totalChunks }
    coverUploads     : [],  // { trackId, coverPath, mimeType }
    featuredCalls    : [],  // trackId
    commentCalls     : [],  // { trackId, author, text }
    guestbookCalls   : [],  // { author, text }
    adminCalls       : [],  // principal text
    skipped          : {
      replies        : Object.values(manifest.replies || {}).reduce((n, arr) => n + arr.length, 0),
      playCounts     : (manifest.playCounts || []).length,
      tomatoCounts   : (manifest.tomatoCounts || []).length,
      tracksNoAudio  : 0,
      coversMissing  : 0,
    },
  };

  for (const track of manifest.tracks) {
    if (metadataOnly) {
      plan.skipped.tracksNoAudio++;
      continue;
    }
    const audioPath = findAudioFile(backupDir, track.id);
    if (!audioPath) {
      plan.skipped.tracksNoAudio++;
      continue;
    }
    plan.trackUploads.push({ track, audioPath });

    if (track.coverArtType) {
      const coverPath = findCoverFile(backupDir, track.id);
      if (coverPath) {
        plan.coverUploads.push({ trackId: track.id, coverPath, mimeType: track.coverArtType });
      } else {
        plan.skipped.coversMissing++;
      }
    }
  }

  if (!metadataOnly) {
    for (const trackId of manifest.featured || []) {
      plan.featuredCalls.push(trackId);
    }
    for (const [trackId, arr] of Object.entries(manifest.comments || {})) {
      for (const c of arr) {
        plan.commentCalls.push({ trackId, author: c.author, text: c.text });
      }
    }
  }

  // Guestbook and admins do not depend on tracks, so they are always replayed.
  for (const entry of manifest.guestbook || []) {
    plan.guestbookCalls.push({ author: entry.author, text: entry.text });
  }
  for (const principalText of manifest.admins || []) {
    plan.adminCalls.push(principalText);
  }

  return plan;
}

function printPlan(plan, backupDir, metadataOnly, target) {
  console.log('━'.repeat(60));
  console.log('  RESTORE PLAN');
  console.log('━'.repeat(60));
  console.log(`  Backup dir:    ${backupDir}`);
  console.log(`  Target:        ${target || '(dry run)'}`);
  console.log(`  Mode:          ${metadataOnly ? 'metadata-only' : 'full'}`);
  console.log();
  console.log(`  Operations to execute:`);
  console.log(`    Track uploads (finalizeTrack + chunks):  ${plan.trackUploads.length}`);
  console.log(`    Cover art uploads (setCoverArt):         ${plan.coverUploads.length}`);
  console.log(`    Featured flags (setFeatured):            ${plan.featuredCalls.length}`);
  console.log(`    Comment replays (addComment):            ${plan.commentCalls.length}`);
  console.log(`    Guestbook replays (addGuestbookEntry):   ${plan.guestbookCalls.length}`);
  console.log(`    Admin adds (addAdmin):                   ${plan.adminCalls.length}`);
  console.log();
  console.log(`  Operations SKIPPED:`);
  console.log(`    Replies (no backend method for old→new ID remap):    ${plan.skipped.replies}`);
  console.log(`    Play counts (no admin setter):                       ${plan.skipped.playCounts}`);
  console.log(`    Tomato counts (no admin setter):                     ${plan.skipped.tomatoCounts}`);
  console.log(`    Tracks without audio file on disk:                   ${plan.skipped.tracksNoAudio}`);
  console.log(`    Covers missing on disk (but declared in manifest):   ${plan.skipped.coversMissing}`);
  console.log();

  // Estimate network calls
  const totalChunkCalls = plan.trackUploads.reduce((n, u) => n + Number(u.track.totalChunks), 0);
  const totalUpdateCalls =
    plan.trackUploads.length +          // finalizeTrack per track
    totalChunkCalls +                   // uploadChunk per chunk
    plan.coverUploads.length +
    plan.featuredCalls.length +
    plan.commentCalls.length +
    plan.guestbookCalls.length +
    plan.adminCalls.length;
  console.log(`  Estimated update calls: ${totalUpdateCalls}`);
  console.log(`    (of which chunk uploads: ${totalChunkCalls})`);
  console.log('━'.repeat(60));
}

// ── Executor ────────────────────────────────────────────────────────────
async function executePlan(plan, actor) {
  let opCount = 0;
  const start = Date.now();

  // 1. Tracks + chunks
  for (const { track, audioPath } of plan.trackUploads) {
    const bytes = readFileSync(audioPath);
    const total = Number(track.totalChunks);
    console.log(`  [track] ${track.id} (${total} chunks)`);
    for (let i = 0; i < total; i++) {
      const start = i * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, bytes.length);
      await actor.uploadChunk(track.id, BigInt(i), Array.from(bytes.slice(start, end)));
      opCount++;
    }
    await actor.finalizeTrack(
      track.id,
      track.name,
      track.artist,
      track.album,
      BigInt(track.trackNumber),
      BigInt(track.totalChunks),
      track.mimeType,
      BigInt(track.size),
    );
    opCount++;
  }

  // 2. Cover art
  for (const { trackId, coverPath, mimeType } of plan.coverUploads) {
    const bytes = readFileSync(coverPath);
    await actor.setCoverArt(trackId, Array.from(bytes), mimeType);
    opCount++;
    console.log(`  [cover] ${trackId}`);
  }

  // 3. Featured
  for (const trackId of plan.featuredCalls) {
    await actor.setFeatured(trackId, true);
    opCount++;
  }
  if (plan.featuredCalls.length > 0) {
    console.log(`  [featured] ${plan.featuredCalls.length} tracks flagged`);
  }

  // 4. Comments
  for (const { trackId, author, text } of plan.commentCalls) {
    try {
      await actor.addComment(trackId, author, text);
      opCount++;
    } catch (e) {
      console.log(`  [comment FAILED] ${trackId}: ${e.message?.slice(0, 80)}`);
    }
  }
  if (plan.commentCalls.length > 0) {
    console.log(`  [comments] ${plan.commentCalls.length} replayed`);
  }

  // 5. Guestbook
  for (const { author, text } of plan.guestbookCalls) {
    try {
      await actor.addGuestbookEntry(author, text);
      opCount++;
    } catch (e) {
      console.log(`  [guestbook FAILED] ${e.message?.slice(0, 80)}`);
    }
  }
  if (plan.guestbookCalls.length > 0) {
    console.log(`  [guestbook] ${plan.guestbookCalls.length} replayed`);
  }

  // 6. Admins
  for (const principalText of plan.adminCalls) {
    try {
      await actor.addAdmin(Principal.fromText(principalText));
      opCount++;
    } catch (e) {
      console.log(`  [admin FAILED] ${principalText}: ${e.message?.slice(0, 80)}`);
    }
  }
  if (plan.adminCalls.length > 0) {
    console.log(`  [admins] ${plan.adminCalls.length} replayed`);
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log();
  console.log(`Executed ${opCount} update calls in ${elapsed}s`);
}

// ── Main ────────────────────────────────────────────────────────────────
async function main() {
  const backupDir = resolve(process.cwd(), BACKUP_DIR);
  console.log(`Loading manifest from ${backupDir}...`);
  const manifest = loadManifest(backupDir);
  console.log(`Manifest: ${manifest.counts.tracks} tracks, ${manifest.counts.comments} comments, ${manifest.counts.replies ?? 0} replies, ${manifest.counts.guestbook} guestbook, ${manifest.counts.featured ?? 0} featured`);
  console.log(`Source canister: ${manifest.canisterId}`);
  console.log(`Backed up at:    ${manifest.backedUpAt}`);
  console.log();

  const plan = buildPlan(manifest, backupDir, METADATA_ONLY);
  printPlan(plan, backupDir, METADATA_ONLY, TARGET_CANISTER);

  if (DRY_RUN) {
    console.log('\nDRY RUN — no network calls executed.');
    return;
  }

  // Real restore path: load admin identity and fire the plan.
  const pem = readFileSync(ADMIN_PEM_PATH, 'utf8');
  const identity = Secp256k1KeyIdentity.fromPem(pem);
  console.log(`\nUsing identity: ${identity.getPrincipal().toText()}`);
  console.log(`Target canister: ${TARGET_CANISTER}`);
  console.log();
  const agent = await HttpAgent.create({ host: 'https://icp-api.io', identity });
  const actor = Actor.createActor(idlFactory, { agent, canisterId: TARGET_CANISTER });

  // Pre-flight: the target should be empty (or you're restoring into a
  // known-empty staging). We do a quick listTracks check for safety.
  const existing = await actor.listTracks();
  if (existing.length > 0 && !args.includes('--append-over-existing')) {
    console.error(`\nERROR: target canister already has ${existing.length} tracks.`);
    console.error('Restore refuses to run against a non-empty canister unless --append-over-existing is passed.');
    console.error('For a clean restore, deploy a fresh staging canister first.');
    process.exit(1);
  }

  await executePlan(plan, actor);
  console.log('\nRestore complete.');
}

main().catch(e => {
  console.error('\nFatal:', e.message);
  if (e.stack) console.error(e.stack);
  process.exit(1);
});
