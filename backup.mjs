#!/usr/bin/env node
/**
 * Cloud Records Backup Script
 *
 * Downloads all tracks (audio + cover art) and metadata from the canister
 * into a local directory you can keep in cold storage.
 *
 * Output:
 *   backups/cloud-records-YYYY-MM-DD/
 *     manifest.json         — track list, comments, guestbook, admin list
 *     audio/{trackId}.mp3   — assembled audio files
 *     covers/{trackId}.{ext}— cover art
 *
 * Usage:
 *   node backup.mjs                # full backup
 *   node backup.mjs --metadata     # metadata only (skip audio/cover bytes)
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url + '/../frontend/');
const { Actor, HttpAgent } = require('@dfinity/agent');
import { mkdirSync, writeFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';

const CANISTER_ID = 'kfhms-uaaaa-aaaae-ageyq-cai';
const METADATA_ONLY = process.argv.includes('--metadata');

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
    listTracks   : IDL.Func([], [IDL.Vec(TrackInfo)], ['query']),
    getChunk     : IDL.Func([IDL.Text, IDL.Nat], [IDL.Opt(IDL.Vec(IDL.Nat8))], ['query']),
    getCoverArt  : IDL.Func([IDL.Text], [IDL.Opt(IDL.Vec(IDL.Nat8))], ['query']),
    getComments  : IDL.Func([IDL.Text], [IDL.Vec(Comment)], ['query']),
    getGuestbook : IDL.Func([], [IDL.Vec(GuestbookEntry)], ['query']),
    listAdmins   : IDL.Func([], [IDL.Vec(IDL.Principal)], ['query']),
  });
};

function bigIntReplacer(_key, value) {
  return typeof value === 'bigint' ? value.toString() : value;
}

function mimeToExt(mime) {
  const map = {
    'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/mp4': 'm4a',
    'audio/wav': 'wav', 'audio/x-wav': 'wav',
    'audio/ogg': 'ogg', 'audio/flac': 'flac',
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg',
    'image/webp': 'webp', 'image/gif': 'gif',
  };
  return map[mime] || 'bin';
}

async function fetchAllChunks(actor, track) {
  const total = Number(track.totalChunks);
  const parts = [];
  for (let i = 0; i < total; i++) {
    const result = await actor.getChunk(track.id, BigInt(i));
    if (result.length === 0) {
      throw new Error(`Chunk ${i} missing for ${track.id}`);
    }
    parts.push(result[0]);
  }
  const totalLen = parts.reduce((s, p) => s + p.length, 0);
  const merged = new Uint8Array(totalLen);
  let off = 0;
  for (const p of parts) {
    merged.set(p, off);
    off += p.length;
  }
  return merged;
}

async function main() {
  const agent = await HttpAgent.create({ host: 'https://icp-api.io' });
  const actor = Actor.createActor(idlFactory, { agent, canisterId: CANISTER_ID });

  console.log('Connected to canister:', CANISTER_ID);
  console.log('Mode:', METADATA_ONLY ? 'metadata only' : 'full backup (audio + cover art)');

  const date = new Date().toISOString().slice(0, 10);
  const outDir = resolve(process.cwd(), 'backups', `cloud-records-${date}`);
  if (existsSync(outDir)) {
    console.log(`Backup directory exists, will overwrite: ${outDir}`);
  }
  mkdirSync(join(outDir, 'audio'),  { recursive: true });
  mkdirSync(join(outDir, 'covers'), { recursive: true });

  console.log('\nFetching metadata...');
  const tracks    = await actor.listTracks();
  const guestbook = await actor.getGuestbook();
  const admins    = await actor.listAdmins();
  console.log(`  ${tracks.length} tracks, ${guestbook.length} guestbook entries, ${admins.length} admins`);

  // Comments per track
  console.log('\nFetching comments...');
  const comments = {};
  for (const t of tracks) {
    const c = await actor.getComments(t.id);
    if (c.length > 0) comments[t.id] = c;
  }
  const commentTotal = Object.values(comments).reduce((n, arr) => n + arr.length, 0);
  console.log(`  ${commentTotal} comments across ${Object.keys(comments).length} tracks`);

  const manifest = {
    backedUpAt : new Date().toISOString(),
    canisterId : CANISTER_ID,
    counts     : {
      tracks    : tracks.length,
      comments  : commentTotal,
      guestbook : guestbook.length,
      admins    : admins.length,
    },
    tracks,
    comments,
    guestbook,
    admins: admins.map(p => p.toString()),
  };

  writeFileSync(
    join(outDir, 'manifest.json'),
    JSON.stringify(manifest, bigIntReplacer, 2),
  );
  console.log(`\nWrote manifest.json`);

  if (METADATA_ONLY) {
    console.log(`\nMetadata-only backup complete: ${outDir}`);
    return;
  }

  console.log('\nDownloading audio and cover art...');
  let okCount = 0, failCount = 0, totalBytes = 0;
  for (let i = 0; i < tracks.length; i++) {
    const t = tracks[i];
    const ext = mimeToExt(t.mimeType);
    const audioPath = join(outDir, 'audio', `${t.id}.${ext}`);
    process.stdout.write(`  [${i+1}/${tracks.length}] ${t.name.padEnd(40).slice(0, 40)} `);
    try {
      const data = await fetchAllChunks(actor, t);
      writeFileSync(audioPath, data);
      totalBytes += data.length;

      // Cover art
      if (t.coverArtType) {
        const coverResult = await actor.getCoverArt(t.id);
        if (coverResult.length > 0) {
          const coverExt = mimeToExt(t.coverArtType);
          writeFileSync(join(outDir, 'covers', `${t.id}.${coverExt}`), coverResult[0]);
        }
      }
      okCount++;
      console.log(`OK (${(data.length/1024/1024).toFixed(1)}MB)`);
    } catch (e) {
      failCount++;
      console.log(`FAIL — ${e.message?.slice(0, 50)}`);
    }
  }

  console.log(`\n=== Backup complete ===`);
  console.log(`Location: ${outDir}`);
  console.log(`Tracks:   ${okCount} ok, ${failCount} failed`);
  console.log(`Total:    ${(totalBytes/1024/1024).toFixed(1)} MB`);
}

main().catch(e => {
  console.error('Fatal:', e.message);
  console.error(e.stack);
  process.exit(1);
});
