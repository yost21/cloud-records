import { Actor, HttpAgent } from "@dfinity/agent";
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
  onProgress : (p: UploadProgress) => void
): Promise<string> {
  const actor      = await getActor();
  const trackId    = `track-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const buffer     = await file.arrayBuffer();
  const bytes      = new Uint8Array(buffer);
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
    BigInt(file.size)
  );

  if (metadata.coverArt) {
    const artBuffer = await metadata.coverArt.arrayBuffer();
    const artBytes  = new Uint8Array(artBuffer);
    await actor.setCoverArt(trackId, artBytes, metadata.coverArt.type);
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

export async function getCoverArtUrl(trackId: string, mimeType: string): Promise<string | null> {
  const actor  = await getActor();
  const result = await actor.getCoverArt(trackId);
  if (result.length === 0) return null;
  const raw  = result[0] as Uint8Array;
  const copy = new Uint8Array(raw);
  const blob = new Blob([copy], { type: mimeType || "image/png" });
  return URL.createObjectURL(blob);
}

// ── Playback helpers ──────────────────────────────────────────────────────────

export async function buildAudioUrl(
  trackId     : string,
  totalChunks : number,
  mimeType    : string
): Promise<string> {
  const actor  = await getActor();
  const parts  : Uint8Array[] = [];

  for (let i = 0; i < totalChunks; i++) {
    const result = await actor.getChunk(trackId, BigInt(i));
    if (result.length > 0) {
      parts.push(result[0] as Uint8Array);
    }
  }

  const totalLen = parts.reduce((acc, p) => acc + p.length, 0);
  const merged   = new Uint8Array(totalLen);
  let offset     = 0;
  for (const part of parts) {
    merged.set(part, offset);
    offset += part.length;
  }

  const blob = new Blob([merged], { type: mimeType });
  return URL.createObjectURL(blob);
}
