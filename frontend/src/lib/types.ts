// TypeScript mirror of the Motoko TrackInfo record.
// Candid `nat` and `int` arrive as BigInt from @dfinity/agent.
export interface TrackInfo {
  id           : string;
  name         : string;
  artist       : string;
  album        : string;
  trackNumber  : bigint;
  mimeType     : string;
  totalChunks  : bigint;
  size         : bigint;
  createdAt    : bigint;
  order        : bigint;
  coverArtType : string;
  featured     : boolean;
}

export interface Comment {
  id        : string;
  author    : string;
  text      : string;
  createdAt : bigint;
}

export interface Reply {
  id        : string;
  author    : string;
  text      : string;
  createdAt : bigint;
}

export interface GuestbookEntry {
  id        : string;
  author    : string;
  text      : string;
  createdAt : bigint;
}

export interface TrackPlayInfo {
  trackId : string;
  name    : string;
  artist  : string;
  plays   : bigint;
}

export interface Stats {
  totalTracks    : bigint;
  totalPlays     : bigint;
  totalComments  : bigint;
  totalGuestbook : bigint;
  uniqueListeners: bigint;
  topPlayed      : TrackPlayInfo[];
}

export interface CommentWithContext {
  trackId   : string;
  trackName : string;
  id        : string;
  author    : string;
  text      : string;
  createdAt : bigint;
}

// ── Video types (W5) ────────────────────────────────────────────────────
// Mirror of the Motoko VideoCore + VideoVariant + StorageLocation records.
// `variants` is serialized as an array of (resolution, variant) tuples
// because Candid doesn't project Map.Map directly — see backend/Main.mo
// `projectVideo` helper.

export type StorageLocation =
  | { onChain : null }
  | { offChain : { url : string; provider : string } };

export interface VideoVariant {
  resolution      : string;       // "480p" | "720p" | "1080p"
  size            : bigint;
  totalChunks     : bigint;
  chunkSize       : bigint;
  mimeType        : string;
  storageLocation : StorageLocation;
}

export interface VideoInfo {
  id          : string;            // "v-<trackId>"
  trackId     : string;
  durationSec : bigint;
  variants    : Array<[string, VideoVariant]>;
  createdAt   : bigint;
}

// Typed actor interface matching the IDL factory in idl.ts
export interface BackendActor {
  uploadChunk(
    trackId     : string,
    chunkIndex  : bigint,
    data        : Uint8Array
  ): Promise<void>;

  finalizeTrack(
    trackId     : string,
    name        : string,
    artist      : string,
    album       : string,
    trackNumber : bigint,
    totalChunks : bigint,
    mimeType    : string,
    size        : bigint
  ): Promise<void>;

  setCoverArt(
    trackId     : string,
    data        : Uint8Array,
    artMimeType : string
  ): Promise<void>;

  updateTrack(
    trackId     : string,
    name        : string,
    artist      : string,
    album       : string,
    trackNumber : bigint
  ): Promise<void>;

  deleteTrack(trackId : string): Promise<void>;
  setOrder(trackId : string, newOrder : bigint): Promise<void>;
  setFeatured(trackId : string, isOn : boolean): Promise<void>;
  listFeatured(): Promise<string[]>;
  recordPlay(trackId : string, listenerId : string): Promise<void>;
  throwTomato(trackId : string, listenerId : string): Promise<void>;
  getAllTomatoCounts(): Promise<Array<[string, bigint]>>;
  getPlayCount(trackId : string): Promise<bigint>;
  getPlayLog(trackId : string): Promise<bigint[]>;
  getAllPlayCounts(): Promise<Array<[string, bigint]>>;
  getStats(): Promise<Stats>;
  getAllComments(): Promise<CommentWithContext[]>;

  // Admin
  addAdmin(principal : any): Promise<void>;
  removeAdmin(principal : any): Promise<void>;
  listAdmins(): Promise<any[]>;
  isCallerAdmin(principal : any): Promise<boolean>;

  // Comments
  addComment(trackId: string, author: string, text: string): Promise<void>;
  getComments(trackId: string): Promise<Comment[]>;
  deleteComment(trackId: string, commentId: string): Promise<void>;
  replyToComment(commentId: string, text: string): Promise<void>;
  getReplies(commentId: string): Promise<Reply[]>;
  getAllReplies(): Promise<Array<[string, Reply[]]>>;
  // Guestbook
  addGuestbookEntry(author: string, text: string): Promise<void>;
  getGuestbook(): Promise<GuestbookEntry[]>;
  deleteGuestbookEntry(entryId: string): Promise<void>;

  getTrack(trackId : string): Promise<[TrackInfo] | []>;
  listTracks(): Promise<TrackInfo[]>;
  getCoverArt(trackId : string): Promise<[Uint8Array] | []>;
  getChunk(trackId : string, chunkIndex : bigint): Promise<[Uint8Array] | []>;
  trackCountQuery(): Promise<bigint>;

  // Video queries (W5) — reads only; upload methods are called from the
  // admin Node script (upload-video.mjs) and intentionally not exposed here.
  listVideos(): Promise<VideoInfo[]>;
  getVideo(videoId : string): Promise<[VideoInfo] | []>;
  getVideosByTrack(trackId : string): Promise<VideoInfo[]>;
  getVideoUploadProgress(videoId : string, resolution : string): Promise<bigint[]>;
}
