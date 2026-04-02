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

  // Admin
  addAdmin(principal : any): Promise<void>;
  removeAdmin(principal : any): Promise<void>;
  listAdmins(): Promise<any[]>;
  isCallerAdmin(principal : any): Promise<boolean>;

  getTrack(trackId : string): Promise<[TrackInfo] | []>;
  listTracks(): Promise<TrackInfo[]>;
  getCoverArt(trackId : string): Promise<[Uint8Array] | []>;
  getChunk(trackId : string, chunkIndex : bigint): Promise<[Uint8Array] | []>;
  trackCountQuery(): Promise<bigint>;
}
