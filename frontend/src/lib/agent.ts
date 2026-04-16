import { Actor, HttpAgent, type Identity } from "@dfinity/agent";
import { AuthClient } from "@dfinity/auth-client";
import { safeGetCanisterEnv } from "@icp-sdk/core/agent/canister-env";
import { idlFactory } from "./idl";
import type { BackendActor } from "./types";

function getBackendCanisterId(): string {
  const env = safeGetCanisterEnv();
  return env?.["PUBLIC_CANISTER_ID:backend"] ?? "kfhms-uaaaa-aaaae-ageyq-cai";
}

const IS_LOCAL = typeof window !== "undefined"
  ? window.location.hostname.endsWith("localhost")
  : import.meta.env.DEV;

const IC_HOST = IS_LOCAL
  ? `${window.location.protocol}//localhost:${window.location.port}`
  : "https://icp-api.io";

const II_URL = IS_LOCAL
  ? `http://localhost:4943?canisterId=rdmx6-jaaaa-aaaaa-aaadq-cai`
  : "https://identity.ic0.app";

// ── Anonymous actor (for public read-only access) ────────────────────────────

let _actor: BackendActor | null = null;

export async function getActor(): Promise<BackendActor> {
  if (_actor) return _actor;

  const agent = new HttpAgent({ host: IC_HOST });

  if (IS_LOCAL) {
    await agent.fetchRootKey().catch(console.warn);
  }

  _actor = Actor.createActor<BackendActor>(idlFactory, {
    agent,
    canisterId: getBackendCanisterId(),
  });

  return _actor;
}

// ── Authenticated actor (for admin operations) ───────────────────────────────

let _authClient: AuthClient | null = null;
let _adminActor: BackendActor | null = null;

export async function getAuthClient(): Promise<AuthClient> {
  if (!_authClient) {
    _authClient = await AuthClient.create({
      idleOptions: { disableIdle: true, disableDefaultIdleCallback: true },
    });
  }
  return _authClient;
}

export async function loginAdmin(): Promise<{ success: boolean; principal?: string; error?: string }> {
  const authClient = await getAuthClient();

  return new Promise((resolve) => {
    authClient.login({
      identityProvider: II_URL,
      maxTimeToLive: BigInt(8) * BigInt(3_600_000_000_000), // 8 hours
      onSuccess: async () => {
        const identity = authClient.getIdentity();
        const principal = identity.getPrincipal().toText();

        const agent = new HttpAgent({ host: IC_HOST, identity });
        if (IS_LOCAL) await agent.fetchRootKey().catch(console.warn);

        _adminActor = Actor.createActor<BackendActor>(idlFactory, {
          agent,
          canisterId: getBackendCanisterId(),
        });

        try {
          const isAdmin = await _adminActor.isCallerAdmin(identity.getPrincipal());
          if (isAdmin) {
            _actor = _adminActor;
            resolve({ success: true, principal });
          } else {
            _adminActor = null;
            resolve({ success: false, error: "Not an admin. Your principal: " + principal });
          }
        } catch (e: any) {
          resolve({ success: false, error: e.message || "Admin check failed" });
        }
      },
      onError: (err) => {
        resolve({ success: false, error: err || "Login cancelled" });
      },
    });
  });
}

export async function logoutAdmin(): Promise<void> {
  const authClient = await getAuthClient();
  await authClient.logout();
  _adminActor = null;
  _actor = null;
}

export function isAdmin(): boolean {
  return _adminActor !== null;
}

// ── Upload helpers ────────────────────────────────────────────────────────────

const CHUNK_SIZE = 1_900_000;

export interface UploadProgress {
  chunksUploaded : number;
  totalChunks    : number;
}

export interface TrackMetadata {
  name        : string;
  artist      : string;
  album       : string;
  trackNumber : number;
  coverArt?   : File;
}

export async function uploadTrack(
  file       : File,
  metadata   : TrackMetadata,
  onProgress : (p: UploadProgress) => void,
  preReadBytes?  : Uint8Array,
  preReadCover?  : Uint8Array
): Promise<string> {
  const actor      = await getActor();
  const trackId    = `track-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const bytes      = preReadBytes ?? new Uint8Array(await file.arrayBuffer());
  const totalChunks = Math.ceil(bytes.length / CHUNK_SIZE);

  for (let i = 0; i < totalChunks; i++) {
    const start = i * CHUNK_SIZE;
    const chunk = bytes.slice(start, start + CHUNK_SIZE);
    await actor.uploadChunk(trackId, BigInt(i), chunk);
    onProgress({ chunksUploaded: i + 1, totalChunks });
  }

  await actor.finalizeTrack(
    trackId,
    metadata.name,
    metadata.artist,
    metadata.album,
    BigInt(metadata.trackNumber),
    BigInt(totalChunks),
    file.type || "audio/mpeg",
    BigInt(bytes.length)
  );

  if (preReadCover && metadata.coverArt) {
    await actor.setCoverArt(trackId, preReadCover, metadata.coverArt.type);
  } else if (metadata.coverArt) {
    const artBytes = new Uint8Array(await metadata.coverArt.arrayBuffer());
    await actor.setCoverArt(trackId, artBytes, metadata.coverArt.type);
  } else {
    // Auto-generate cover art if none provided
    const { generateCoverArt } = await import("./generateCover");
    const generated = await generateCoverArt(metadata.name, metadata.album);
    await actor.setCoverArt(trackId, generated, "image/jpeg");
  }

  return trackId;
}

export async function deleteTrack(trackId: string): Promise<void> {
  const actor = await getActor();
  await actor.deleteTrack(trackId);
}

export async function updateTrack(
  trackId     : string,
  name        : string,
  artist      : string,
  album       : string,
  trackNumber : number
): Promise<void> {
  const actor = await getActor();
  await actor.updateTrack(trackId, name, artist, album, BigInt(trackNumber));
}

export async function setTrackOrder(trackId: string, newOrder: number): Promise<void> {
  const actor = await getActor();
  await actor.setOrder(trackId, BigInt(newOrder));
}

export async function setFeatured(trackId: string, isOn: boolean): Promise<void> {
  const actor = await getActor();
  await actor.setFeatured(trackId, isOn);
}

function getListenerId(): string {
  const KEY = "cr-listener-id";
  let id = localStorage.getItem(KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(KEY, id);
  }
  return id;
}

export async function recordPlay(trackId: string): Promise<void> {
  const actor = await getActor();
  await actor.recordPlay(trackId, getListenerId());
}

export async function getPlayLog(trackId: string): Promise<bigint[]> {
  const actor = await getActor();
  return actor.getPlayLog(trackId);
}

export async function getPlayCount(trackId: string): Promise<bigint> {
  const actor = await getActor();
  return actor.getPlayCount(trackId);
}

export async function throwTomato(trackId: string): Promise<void> {
  const actor = await getActor();
  const KEY = "cr-listener-id";
  let id = localStorage.getItem(KEY);
  if (!id) { id = crypto.randomUUID(); localStorage.setItem(KEY, id); }
  await actor.throwTomato(trackId, id);
}

export async function getAllTomatoCounts(): Promise<Map<string, number>> {
  const actor = await getActor();
  const result = await actor.getAllTomatoCounts();
  const map = new Map<string, number>();
  for (const [id, count] of result) map.set(id, Number(count));
  return map;
}

export async function getAllPlayCounts(): Promise<Map<string, number>> {
  const actor = await getActor();
  const result = await actor.getAllPlayCounts();
  const map = new Map<string, number>();
  for (const [id, count] of result) map.set(id, Number(count));
  return map;
}

export async function getStats() {
  const actor = await getActor();
  return actor.getStats();
}

export async function getAllComments() {
  const actor = await getActor();
  return actor.getAllComments();
}

export async function getCoverArtUrl(trackId: string, mimeType: string): Promise<string | null> {
  const actor  = await getActor();
  const result = await actor.getCoverArt(trackId);
  if (result.length === 0) return null;
  const raw  = result[0] as Uint8Array;
  const copy = new Uint8Array(raw);
  const blob = new Blob([copy], { type: mimeType || "image/png" });
  return URL.createObjectURL(blob);
}

// ── Comments & Guestbook ─────────────────────────────────────────────────────

import type { Comment, GuestbookEntry } from "./types";

export async function addComment(trackId: string, author: string, text: string): Promise<void> {
  const actor = await getActor();
  await actor.addComment(trackId, author, text);
}

export async function getComments(trackId: string): Promise<Comment[]> {
  const actor = await getActor();
  return actor.getComments(trackId);
}

export async function deleteCommentApi(trackId: string, commentId: string): Promise<void> {
  const actor = await getActor();
  await actor.deleteComment(trackId, commentId);
}

export async function replyToComment(commentId: string, text: string): Promise<void> {
  const actor = await getActor();
  await actor.replyToComment(commentId, text);
}

export async function getReplies(commentId: string) {
  const actor = await getActor();
  return actor.getReplies(commentId);
}

export async function getAllReplies() {
  const actor = await getActor();
  return actor.getAllReplies();
}

export async function addGuestbookEntry(author: string, text: string): Promise<void> {
  const actor = await getActor();
  await actor.addGuestbookEntry(author, text);
}

export async function getGuestbookEntries(): Promise<GuestbookEntry[]> {
  const actor = await getActor();
  return actor.getGuestbook();
}

export async function deleteGuestbookEntryApi(entryId: string): Promise<void> {
  const actor = await getActor();
  await actor.deleteGuestbookEntry(entryId);
}

// ── Playback helpers ──────────────────────────────────────────────────────────

import { getCached, putCached } from "./audioCache";

export interface FetchProgress {
  loaded : number;  // chunks fetched
  total  : number;  // total chunks
}

export async function buildAudioUrl(
  trackId     : string,
  totalChunks : number,
  mimeType    : string,
  onProgress? : (p: FetchProgress) => void
): Promise<string> {
  // Check cache first — if hit, no canister calls needed
  const cached = await getCached(trackId);
  if (cached) {
    onProgress?.({ loaded: totalChunks, total: totalChunks });
    return URL.createObjectURL(cached);
  }

  const actor = await getActor();
  const CONCURRENCY = 4;
  const parts: (Uint8Array | null)[] = new Array(totalChunks).fill(null);
  let loaded = 0;

  // Fetch a single chunk with retries. Mobile networks drop calls; the old
  // code silently skipped failed chunks, which corrupted the audio file and
  // broke duration/seek mapping (playback struggled, playhead landed on
  // wrong positions). Now we retry, and if a chunk truly can't be fetched
  // we throw so the UI can report the failure instead of producing garbage.
  const fetchChunk = async (idx: number): Promise<Uint8Array> => {
    const MAX_ATTEMPTS = 4;
    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        const result = await actor.getChunk(trackId, BigInt(idx));
        if (result.length === 0) {
          throw new Error(`Chunk ${idx} missing on canister`);
        }
        return new Uint8Array(result[0] as Uint8Array);
      } catch (err) {
        lastError = err;
        if (attempt < MAX_ATTEMPTS - 1) {
          await new Promise(r => setTimeout(r, 200 * Math.pow(2, attempt)));
        }
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error(`Failed to fetch chunk ${idx}`);
  };

  for (let start = 0; start < totalChunks; start += CONCURRENCY) {
    const batch: Promise<void>[] = [];
    for (let j = 0; j < Math.min(CONCURRENCY, totalChunks - start); j++) {
      const idx = start + j;
      batch.push(fetchChunk(idx).then(bytes => {
        parts[idx] = bytes;
        loaded++;
        onProgress?.({ loaded, total: totalChunks });
      }));
    }
    await Promise.all(batch);
  }

  // Integrity check — never assemble a partial file. Wrong order or missing
  // chunks would produce playable-but-corrupt audio with broken seeking.
  for (let i = 0; i < totalChunks; i++) {
    if (parts[i] === null) {
      throw new Error(`Chunk ${i} missing after fetch; refusing to assemble corrupted audio`);
    }
  }

  const totalLen = parts.reduce((acc, p) => acc + (p ? p.length : 0), 0);
  const merged = new Uint8Array(totalLen);
  let offset = 0;
  for (const part of parts) {
    if (!part) continue;
    merged.set(part, offset);
    offset += part.length;
  }

  const blob = new Blob([merged], { type: mimeType });
  // Fire-and-forget cache write
  putCached(trackId, blob, mimeType).catch(() => {});
  return URL.createObjectURL(blob);
}
