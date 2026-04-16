import Map "mo:core/Map";
import Text "mo:core/Text";
import Nat "mo:core/Nat";
import Nat8 "mo:core/Nat8";
import Nat32 "mo:core/Nat32";
import Int "mo:core/Int";
import Array "mo:core/Array";
import VarArray "mo:core/VarArray";
import Time "mo:core/Time";
import Runtime "mo:core/Runtime";
import Principal "mo:core/Principal";
import Iter "mo:core/Iter";
import Blob "mo:core/Blob";
import Char "mo:core/Char";

persistent actor MusicPlatform {

  // ── Admin Access Control ──────────────────────────────────────────────────
  // Admin principals that can upload, edit, delete, and manage tracks.
  // The deployer principal is always admin. Additional admins can be added.
  let admins : Map.Map<Principal, Bool> = Map.empty();

  func isAdmin(caller : Principal) : Bool {
    if (Principal.isAnonymous(caller)) return false;
    switch (Map.get(admins, Principal.compare, caller)) {
      case (?true) true;
      case _ false;
    }
  };

  func requireAdmin(caller : Principal) {
    if (not isAdmin(caller)) {
      Runtime.trap("Unauthorized: caller is not an admin")
    }
  };

  public shared(msg) func addAdmin(principal : Principal) : async () {
    // Bootstrap: if no admins exist yet, the first caller becomes admin
    if (Map.size(admins) == 0) {
      Map.add(admins, Principal.compare, msg.caller, true);
    } else {
      requireAdmin(msg.caller);
    };
    Map.add(admins, Principal.compare, principal, true);
  };

  public shared(msg) func removeAdmin(principal : Principal) : async () {
    requireAdmin(msg.caller);
    // Last-admin removal would re-open the addAdmin bootstrap path
    // and let any subsequent caller claim the canister.
    if (Map.size(admins) == 1) {
      switch (Map.get(admins, Principal.compare, principal)) {
        case (?_) Runtime.trap("Cannot remove the last admin");
        case null {};
      };
    };
    ignore Map.delete(admins, Principal.compare, principal);
  };

  public query func listAdmins() : async [Principal] {
    let entries = Map.entries(admins);
    let arr = Iter.toArray(entries);
    Array.map<(Principal, Bool), Principal>(arr, func((p, _)) = p)
  };

  public query func isCallerAdmin(caller : Principal) : async Bool {
    isAdmin(caller)
  };

  // ── Types ──────────────────────────────────────────────────────────────────

  // Internal storage type — MUST stay identical to the original deployed shape
  // so that mainnet upgrade succeeds via Enhanced Orthogonal Persistence.
  type TrackCore = {
    id          : Text;
    name        : Text;
    mimeType    : Text;
    totalChunks : Nat;
    size        : Nat;
    createdAt   : Int;
    order       : Nat;
  };

  // Extended metadata — stored in a separate map added post-upgrade.
  type TrackExtra = {
    artist       : Text;
    album        : Text;
    trackNumber  : Nat;
    coverArtType : Text;
  };

  // Public API response — merged from core + extras.
  public type TrackInfo = {
    id           : Text;
    name         : Text;
    artist       : Text;
    album        : Text;
    trackNumber  : Nat;
    mimeType     : Text;
    totalChunks  : Nat;
    size         : Nat;
    createdAt    : Int;
    order        : Nat;
    coverArtType : Text;
    featured     : Bool;
  };

  // ── Video types (W2) ──────────────────────────────────────────────────────
  // Video = per-track multi-rendition record. Phase 1 scope: 480p on-chain only,
  // 720p/1080p deferred to Phase 2 off-chain via `storageLocation`. `variants`
  // is a Map keyed by resolution so insert/update is O(log n) and Phase 2 can
  // add redundancy without a Candid type migration.
  //
  // `id` is enforced as `"v-" # trackId` on create in `finalizeVideoVariant`.
  // The separate field gives Phase 2+ flexibility (multiple videos per track)
  // without reshaping the schema.
  //
  // `chunkSize` is stored per-variant so `readVideoRange` does deterministic
  // offset math without assuming a global constant. `uploadVideoChunk` enforces
  // that every non-final chunk matches this value and `finalizeVideoVariant`
  // validates the final chunk's expected size.

  public type StorageLocation = {
    #onChain;
    #offChain : { url : Text; provider : Text };
  };

  public type VideoVariant = {
    resolution      : Text;   // "480p" | "720p" | "1080p"
    size            : Nat;    // total bytes of this variant
    totalChunks     : Nat;    // number of chunks in storage (0 for #offChain)
    chunkSize       : Nat;    // every non-final chunk is exactly this size
    mimeType        : Text;
    storageLocation : StorageLocation;
  };

  public type VideoCore = {
    id          : Text;   // "v-<trackId>"
    trackId     : Text;
    durationSec : Nat;
    variants    : Map.Map<Text, VideoVariant>;
    createdAt   : Int;
  };

  // Flat public-API version of VideoCore used by query methods. Candid does
  // not serialize mo:core Map.Map directly, so we project variants to an
  // array of (resolution, VideoVariant) tuples.
  public type VideoInfo = {
    id          : Text;
    trackId     : Text;
    durationSec : Nat;
    variants    : [(Text, VideoVariant)];
    createdAt   : Int;
  };

  // ── Storage ────────────────────────────────────────────────────────────────
  // Original maps — type-identical to first deploy for upgrade compatibility.
  let tracks     : Map.Map<Text, TrackCore>  = Map.empty();
  let trackOrder : Map.Map<Nat, Text>        = Map.empty();
  let chunks     : Map.Map<Text, Blob>       = Map.empty();
  var trackCount : Nat = 0;

  // New maps — created fresh on upgrade, empty for migrated canisters.
  let trackExtras : Map.Map<Text, TrackExtra> = Map.empty();
  let coverArts   : Map.Map<Text, Blob>       = Map.empty();
  let featured    : Map.Map<Text, Bool>       = Map.empty();
  let playCounts  : Map.Map<Text, Nat>        = Map.empty();
  // Rolling log of recent play timestamps (capped per track) for activity charts
  let playLog     : Map.Map<Text, [Int]>      = Map.empty();
  // DEPRECATED: global per-principal cooldown was too aggressive — suppressed
  // legitimate plays when users quickly switched tracks. Kept for EOP compat.
  let lastPlayAt  : Map.Map<Principal, Int>   = Map.empty();
  // Per-principal-per-track cooldown — composite key "principal:trackId"
  let playRateLimit : Map.Map<Text, Int>      = Map.empty();
  // Total plays counter (denormalized for fast stats)
  var totalPlays  : Nat = 0;
  // Unique listeners: Set of browser UUIDs per track + global set
  let uniqueListeners       : Map.Map<Text, Bool> = Map.empty();  // global set of all UUIDs
  let uniqueListenersPerTrack : Map.Map<Text, Bool> = Map.empty();  // key: "uuid:trackId"
  // Tomato button — per-track "boo" counts (fun engagement feature)
  let tomatoCounts : Map.Map<Text, Nat> = Map.empty();
  // Per-listener-per-track dedup for tomatoes
  let tomatoDedup  : Map.Map<Text, Bool> = Map.empty();  // key: "listenerId:trackId"
  // Cap rolling play log per track
  let MAX_PLAY_LOG_PER_TRACK : Nat = 200;

  // ── W1.3 Eviction state ───────────────────────────────────────────────────
  // Monotonic write-order queues for the five unbounded maps. Each write past
  // the cap evicts the oldest entry (smallest counter) from both the order map
  // and its companion main map. Reverse index maps give O(log n) updates for
  // write-update maps (playRateLimit, lastPostAt) and enable deleteTrack zombie
  // cleanup for write-once maps (uniqueListenersPerTrack, tomatoDedup).
  //
  // Pre-upgrade entries that predate this logic are "ghosts" — present in the
  // main map but not in order/reverse, so they cannot be evicted until they are
  // rewritten. Ghost counts are bounded by pre-upgrade state size (currently
  // <1000 total across all maps) and one-time. All eviction helpers tolerate
  // ghosts by looping past stale order entries if needed.
  //
  // NEW persistent fields — empty on first boot post-upgrade, safe under EOP.

  let MAX_UNIQUE_LISTENERS           : Nat = 50_000;
  let MAX_UNIQUE_LISTENERS_PER_TRACK : Nat = 50_000;
  let MAX_TOMATO_DEDUP               : Nat = 100_000;
  let MAX_PLAY_RATE_LIMIT            : Nat = 10_000;
  let MAX_LAST_POST_AT               : Nat = 10_000;

  let uniqueListenersOrder           : Map.Map<Nat, Text>      = Map.empty();
  let uniqueListenersReverse         : Map.Map<Text, Nat>      = Map.empty();
  var uniqueListenersCounter         : Nat = 0;

  let uniqueListenersPerTrackOrder   : Map.Map<Nat, Text>      = Map.empty();
  let uniqueListenersPerTrackReverse : Map.Map<Text, Nat>      = Map.empty();
  var uniqueListenersPerTrackCounter : Nat = 0;

  let tomatoDedupOrder               : Map.Map<Nat, Text>      = Map.empty();
  let tomatoDedupReverse             : Map.Map<Text, Nat>      = Map.empty();
  var tomatoDedupCounter             : Nat = 0;

  let playRateLimitOrder             : Map.Map<Nat, Text>      = Map.empty();
  let playRateLimitReverse           : Map.Map<Text, Nat>      = Map.empty();
  var playRateLimitCounter           : Nat = 0;

  let lastPostAtOrder                : Map.Map<Nat, Principal> = Map.empty();
  let lastPostAtReverse              : Map.Map<Principal, Nat> = Map.empty();
  var lastPostAtCounter              : Nat = 0;

  // ── W2 Video state ────────────────────────────────────────────────────────
  // NEW persistent fields — empty on first boot post-upgrade, safe under EOP.
  // Video chunks live in the existing `chunks : Map<Text, Blob>` under a
  // disjoint `"vid:"` key prefix so audio and video namespaces cannot collide.

  let VIDEO_MAX_SLICE           : Nat = 3 * 512 * 1024;   // 1_572_864 — matches OpenChat production
  let VIDEO_CHUNK_SIZE_DEFAULT  : Nat = 1_500_000;        // uploader target; stored per-variant
  let MAX_VIDEOS                : Nat = 20;
  let MAX_VIDEO_SIZE_BYTES      : Nat = 150 * 1024 * 1024;
  let MAX_CHUNKS_PER_VARIANT    : Nat = 100;

  let videos : Map.Map<Text, VideoCore> = Map.empty();

  // Video chunks share the `chunks` map but are namespaced under "vid:" so a
  // pathological audio trackId can never collide with a video chunk key.
  func videoChunkKey(videoId : Text, resolution : Text, i : Nat) : Text {
    "vid:" # videoId # "-" # resolution # ":" # Nat.toText(i)
  };

  // ── Comments & Guestbook ──────────────────────────────────────────────────

  type Comment = {
    id        : Text;
    author    : Text;
    text      : Text;
    createdAt : Int;
  };

  type GuestbookEntry = {
    id        : Text;
    author    : Text;
    text      : Text;
    createdAt : Int;
  };

  let comments : Map.Map<Text, [Comment]> = Map.empty();
  var commentCount : Nat = 0;
  var guestbook : [GuestbookEntry] = [];
  var guestbookCount : Nat = 0;

  // Admin replies to comments — separate map for EOP compatibility
  type Reply = {
    id        : Text;
    author    : Text;
    text      : Text;
    createdAt : Int;
  };
  let replies : Map.Map<Text, [Reply]> = Map.empty();  // key: commentId
  var replyCount : Nat = 0;

  // Rate limiting: principal -> last post timestamp (nanoseconds)
  let lastPostAt : Map.Map<Principal, Int> = Map.empty();

  // Storage caps to prevent unbounded growth / cycle drain
  let MAX_COMMENTS_PER_TRACK : Nat = 100;
  let MAX_GUESTBOOK_ENTRIES  : Nat = 500;
  // Rate limits in nanoseconds
  let RATE_LIMIT_AUTH_NS  : Int = 30_000_000_000;     // 30 seconds for II users
  let RATE_LIMIT_ANON_NS  : Int = 60_000_000_000;     // 60 seconds shared by all anonymous

  // ── Helpers ────────────────────────────────────────────────────────────────

  func chunkKey(trackId : Text, idx : Nat) : Text {
    trackId # ":" # Nat.toText(idx)
  };

  func defaultExtra() : TrackExtra {
    { artist = ""; album = ""; trackNumber = 0; coverArtType = "" }
  };

  func isFeatured(trackId : Text) : Bool {
    switch (Map.get(featured, Text.compare, trackId)) {
      case (?true) true;
      case _ false;
    }
  };

  // Enforce rate limit and record this post. Traps if too soon.
  func checkRateLimit(caller : Principal) {
    let now = Time.now();
    let isAnon = Principal.isAnonymous(caller);
    let limit = if (isAnon) RATE_LIMIT_ANON_NS else RATE_LIMIT_AUTH_NS;
    switch (Map.get(lastPostAt, Principal.compare, caller)) {
      case (?prev) {
        if (now - prev < limit) {
          Runtime.trap("Slow down — please wait before posting again");
        };
      };
      case null {};
    };
    lastPostAtCounter := updateTimestampPrincipal(
      lastPostAt, lastPostAtOrder, lastPostAtReverse,
      MAX_LAST_POST_AT, lastPostAtCounter, caller, now
    );
  };

  // Reject obvious link spam
  func containsLinkSpam(text : Text) : Bool {
    Text.contains(text, #text "http://") or
    Text.contains(text, #text "https://") or
    Text.contains(text, #text "www.")
  };

  func validateAuthor(author : Text) : Text {
    if (Text.size(author) == 0) return "Anonymous";
    if (Text.size(author) > 50) Runtime.trap("Name too long (max 50 chars)");
    author
  };

  func validateBody(text : Text) {
    if (Text.size(text) == 0) Runtime.trap("Message cannot be empty");
    if (Text.size(text) > 500) Runtime.trap("Message too long (max 500 chars)");
    if (containsLinkSpam(text)) Runtime.trap("Links are not allowed in messages");
  };

  func mergeTrack(core : TrackCore, extra : TrackExtra) : TrackInfo {
    {
      id           = core.id;
      name         = core.name;
      artist       = extra.artist;
      album        = extra.album;
      trackNumber  = extra.trackNumber;
      mimeType     = core.mimeType;
      totalChunks  = core.totalChunks;
      size         = core.size;
      createdAt    = core.createdAt;
      order        = core.order;
      coverArtType = extra.coverArtType;
      featured     = isFeatured(core.id);
    }
  };

  func getExtra(trackId : Text) : TrackExtra {
    switch (Map.get(trackExtras, Text.compare, trackId)) {
      case (?e) e;
      case null defaultExtra();
    }
  };

  // ── W1.3 Eviction helpers ────────────────────────────────────────────────
  // Each helper encapsulates the order-map + reverse-map + main-map triad for
  // one capped map. Two families:
  //
  // - addWriteOnce*: the caller has already verified the key is absent.
  //   Inserts (counter, key) into order, (key, counter) into reverse, and
  //   (key, value) into main. Pops oldest if over cap.
  //
  // - updateTimestamp*: for write-update keyed by timestamp. Removes the prior
  //   (counter, key) pair from order+reverse if it exists, then inserts a
  //   fresh counter, and upserts main. Pops oldest if over cap.
  //
  // The pop-oldest step for write-update maps ALSO cleans up the reverse map
  // so the invariant |order| == |reverse| holds. Ghost pre-upgrade entries
  // cannot be evicted (they're not in order); the pop loop bails on an empty
  // order iterator, which is fine — ghost counts are bounded and one-time.
  //
  // removeWriteOnce*: explicit removal (for deleteTrack zombie cleanup). Same
  // triad, opposite direction.

  func addWriteOnceText(
    main       : Map.Map<Text, Bool>,
    order      : Map.Map<Nat, Text>,
    reverse    : Map.Map<Text, Nat>,
    cap        : Nat,
    counterVal : Nat,
    key        : Text
  ) : Nat {
    // Evict oldest if at cap
    if (Map.size(main) >= cap) {
      switch (Map.entries(order).next()) {
        case (?(oldCounter, oldKey)) {
          ignore Map.delete(order, Nat.compare, oldCounter);
          ignore Map.delete(reverse, Text.compare, oldKey);
          ignore Map.delete(main, Text.compare, oldKey);
        };
        case null {}; // ghost path: order empty but main not, one-time tolerated
      };
    };
    // Insert: new counter, add to order + reverse + main
    let newCounter = counterVal + 1;
    Map.add(order, Nat.compare, newCounter, key);
    Map.add(reverse, Text.compare, key, newCounter);
    Map.add(main, Text.compare, key, true);
    newCounter
  };

  // Remove a key from a write-once triad. Tolerant of ghosts (entries only in
  // main, not in order/reverse).
  func removeWriteOnceText(
    main    : Map.Map<Text, Bool>,
    order   : Map.Map<Nat, Text>,
    reverse : Map.Map<Text, Nat>,
    key     : Text
  ) {
    switch (Map.get(reverse, Text.compare, key)) {
      case (?c) {
        ignore Map.delete(order, Nat.compare, c);
        ignore Map.delete(reverse, Text.compare, key);
      };
      case null {}; // ghost
    };
    ignore Map.delete(main, Text.compare, key);
  };

  // Update (insert or refresh) an Int-valued write-update Text-keyed map.
  // Returns the new counter value.
  func updateTimestampText(
    main       : Map.Map<Text, Int>,
    order      : Map.Map<Nat, Text>,
    reverse    : Map.Map<Text, Nat>,
    cap        : Nat,
    counterVal : Nat,
    key        : Text,
    value      : Int
  ) : Nat {
    // If this key was previously tracked, remove its old order/reverse entries
    // so we don't leave duplicate counters pointing at the same key.
    switch (Map.get(reverse, Text.compare, key)) {
      case (?oldCounter) {
        ignore Map.delete(order, Nat.compare, oldCounter);
        ignore Map.delete(reverse, Text.compare, key);
      };
      case null {};
    };
    // Determine if this is a new insert (for cap check)
    let isNew = switch (Map.get(main, Text.compare, key)) {
      case null true;
      case _ false;
    };
    // Evict oldest if a new insert would exceed cap
    if (isNew and Map.size(main) >= cap) {
      switch (Map.entries(order).next()) {
        case (?(oldCounter, oldKey)) {
          ignore Map.delete(order, Nat.compare, oldCounter);
          ignore Map.delete(reverse, Text.compare, oldKey);
          ignore Map.delete(main, Text.compare, oldKey);
        };
        case null {}; // ghost path
      };
    };
    // Fresh counter, insert order + reverse, upsert main
    let newCounter = counterVal + 1;
    Map.add(order, Nat.compare, newCounter, key);
    Map.add(reverse, Text.compare, key, newCounter);
    ignore Map.delete(main, Text.compare, key);
    Map.add(main, Text.compare, key, value);
    newCounter
  };

  // Principal-keyed variant for lastPostAt.
  func updateTimestampPrincipal(
    main       : Map.Map<Principal, Int>,
    order      : Map.Map<Nat, Principal>,
    reverse    : Map.Map<Principal, Nat>,
    cap        : Nat,
    counterVal : Nat,
    key        : Principal,
    value      : Int
  ) : Nat {
    switch (Map.get(reverse, Principal.compare, key)) {
      case (?oldCounter) {
        ignore Map.delete(order, Nat.compare, oldCounter);
        ignore Map.delete(reverse, Principal.compare, key);
      };
      case null {};
    };
    let isNew = switch (Map.get(main, Principal.compare, key)) {
      case null true;
      case _ false;
    };
    if (isNew and Map.size(main) >= cap) {
      switch (Map.entries(order).next()) {
        case (?(oldCounter, oldKey)) {
          ignore Map.delete(order, Nat.compare, oldCounter);
          ignore Map.delete(reverse, Principal.compare, oldKey);
          ignore Map.delete(main, Principal.compare, oldKey);
        };
        case null {};
      };
    };
    let newCounter = counterVal + 1;
    Map.add(order, Nat.compare, newCounter, key);
    Map.add(reverse, Principal.compare, key, newCounter);
    ignore Map.delete(main, Principal.compare, key);
    Map.add(main, Principal.compare, key, value);
    newCounter
  };

  // ── Upload API ─────────────────────────────────────────────────────────────

  public shared(msg) func uploadChunk(trackId : Text, chunkIndex : Nat, data : Blob) : async () {
    requireAdmin(msg.caller);
    Map.add(chunks, Text.compare, chunkKey(trackId, chunkIndex), data)
  };

  public shared(msg) func finalizeTrack(
    trackId     : Text,
    name        : Text,
    artist      : Text,
    album       : Text,
    trackNumber : Nat,
    totalChunks : Nat,
    mimeType    : Text,
    size        : Nat
  ) : async () {
    requireAdmin(msg.caller);
    let core : TrackCore = {
      id          = trackId;
      name        = name;
      mimeType    = mimeType;
      totalChunks = totalChunks;
      size        = size;
      createdAt   = Time.now();
      order       = trackCount;
    };
    let extra : TrackExtra = {
      artist       = artist;
      album        = album;
      trackNumber  = trackNumber;
      coverArtType = "";
    };
    Map.add(tracks,      Text.compare, trackId,    core);
    Map.add(trackExtras, Text.compare, trackId,    extra);
    Map.add(trackOrder,  Nat.compare,  trackCount, trackId);
    trackCount += 1;
  };

  public shared(msg) func setCoverArt(trackId : Text, data : Blob, artMimeType : Text) : async () {
    requireAdmin(msg.caller);
    switch (Map.get(tracks, Text.compare, trackId)) {
      case (?_) {
        let old = getExtra(trackId);
        let updated : TrackExtra = {
          artist       = old.artist;
          album        = old.album;
          trackNumber  = old.trackNumber;
          coverArtType = artMimeType;
        };
        ignore Map.delete(trackExtras, Text.compare, trackId);
        Map.add(trackExtras, Text.compare, trackId, updated);
        ignore Map.delete(coverArts, Text.compare, trackId);
        Map.add(coverArts, Text.compare, trackId, data);
      };
      case null { Runtime.trap("Track not found: " # trackId) };
    };
  };

  // ── Reorder API ─────────────────────────────────────────────────────────────

  public shared(msg) func setOrder(trackId : Text, newOrder : Nat) : async () {
    requireAdmin(msg.caller);
    switch (Map.get(tracks, Text.compare, trackId)) {
      case (?existing) {
        let oldOrder = existing.order;
        if (oldOrder == newOrder) return;

        // Remove old order mapping
        ignore Map.delete(trackOrder, Nat.compare, oldOrder);

        // Shift other tracks: if moving earlier, bump those in [newOrder, oldOrder) up by 1
        // If moving later, bump those in (oldOrder, newOrder] down by 1
        let active = Map.size(tracks);
        var slot : Nat = 0;
        var shifted : Nat = 0;
        while (shifted < active and slot < trackCount) {
          switch (Map.get(trackOrder, Nat.compare, slot)) {
            case (?otherId) {
              if (otherId != trackId) {
                switch (Map.get(tracks, Text.compare, otherId)) {
                  case (?otherCore) {
                    let o = otherCore.order;
                    var newO = o;
                    if (newOrder < oldOrder and o >= newOrder and o < oldOrder) {
                      newO := o + 1;
                    } else if (newOrder > oldOrder and o > oldOrder and o <= newOrder) {
                      newO := o - 1;
                    };
                    if (newO != o) {
                      ignore Map.delete(trackOrder, Nat.compare, o);
                      Map.add(trackOrder, Nat.compare, newO, otherId);
                      let updatedCore : TrackCore = {
                        id = otherCore.id; name = otherCore.name; mimeType = otherCore.mimeType;
                        totalChunks = otherCore.totalChunks; size = otherCore.size;
                        createdAt = otherCore.createdAt; order = newO;
                      };
                      ignore Map.delete(tracks, Text.compare, otherId);
                      Map.add(tracks, Text.compare, otherId, updatedCore);
                    };
                  };
                  case null {};
                };
              };
              shifted += 1;
            };
            case null {};
          };
          slot += 1;
        };

        // Place this track at newOrder
        Map.add(trackOrder, Nat.compare, newOrder, trackId);
        let updatedCore : TrackCore = {
          id = existing.id; name = existing.name; mimeType = existing.mimeType;
          totalChunks = existing.totalChunks; size = existing.size;
          createdAt = existing.createdAt; order = newOrder;
        };
        ignore Map.delete(tracks, Text.compare, trackId);
        Map.add(tracks, Text.compare, trackId, updatedCore);
      };
      case null {};
    };
  };

  // ── Edit / Delete API ──────────────────────────────────────────────────────

  public shared(msg) func updateTrack(
    trackId     : Text,
    name        : Text,
    artist      : Text,
    album       : Text,
    trackNumber : Nat
  ) : async () {
    requireAdmin(msg.caller);
    switch (Map.get(tracks, Text.compare, trackId)) {
      case (?existing) {
        let updatedCore : TrackCore = {
          id          = existing.id;
          name        = name;
          mimeType    = existing.mimeType;
          totalChunks = existing.totalChunks;
          size        = existing.size;
          createdAt   = existing.createdAt;
          order       = existing.order;
        };
        ignore Map.delete(tracks, Text.compare, trackId);
        Map.add(tracks, Text.compare, trackId, updatedCore);

        let old = getExtra(trackId);
        let updatedExtra : TrackExtra = {
          artist       = artist;
          album        = album;
          trackNumber  = trackNumber;
          coverArtType = old.coverArtType;
        };
        ignore Map.delete(trackExtras, Text.compare, trackId);
        Map.add(trackExtras, Text.compare, trackId, updatedExtra);
      };
      case null { Runtime.trap("Track not found: " # trackId) };
    };
  };

  public shared(msg) func deleteTrack(trackId : Text) : async () {
    requireAdmin(msg.caller);
    switch (Map.get(tracks, Text.compare, trackId)) {
      case (?info) {
        var i : Nat = 0;
        while (i < info.totalChunks) {
          ignore Map.delete(chunks, Text.compare, chunkKey(trackId, i));
          i += 1;
        };
        ignore Map.delete(coverArts, Text.compare, trackId);
        ignore Map.delete(trackExtras, Text.compare, trackId);
        ignore Map.delete(featured, Text.compare, trackId);
        ignore Map.delete(playCounts, Text.compare, trackId);
        ignore Map.delete(playLog, Text.compare, trackId);
        ignore Map.delete(tomatoCounts, Text.compare, trackId);
        ignore Map.delete(trackOrder, Nat.compare, info.order);
        ignore Map.delete(tracks, Text.compare, trackId);

        // W1.3 A9: zombie cleanup. uniqueListenersPerTrack (key "uuid:trackId")
        // and tomatoDedup (key "listenerId:trackId") accumulate entries keyed
        // by this trackId. Walk both maps, collect matching keys by suffix,
        // then remove each via the triad helper so order/reverse stay in sync.
        // Deletes are rare, so O(n) per map is acceptable.
        let suffix : Text = ":" # trackId;
        let listenerZombies : [Text] = Iter.toArray(
          Iter.filter<Text>(
            Map.keys(uniqueListenersPerTrack),
            func(k) = Text.endsWith(k, #text suffix)
          )
        );
        for (k in listenerZombies.vals()) {
          removeWriteOnceText(
            uniqueListenersPerTrack, uniqueListenersPerTrackOrder, uniqueListenersPerTrackReverse,
            k
          );
        };
        let tomatoZombies : [Text] = Iter.toArray(
          Iter.filter<Text>(
            Map.keys(tomatoDedup),
            func(k) = Text.endsWith(k, #text suffix)
          )
        );
        for (k in tomatoZombies.vals()) {
          removeWriteOnceText(
            tomatoDedup, tomatoDedupOrder, tomatoDedupReverse,
            k
          );
        };
      };
      case null {};
    };
  };

  public shared(msg) func setFeatured(trackId : Text, isOn : Bool) : async () {
    requireAdmin(msg.caller);
    switch (Map.get(tracks, Text.compare, trackId)) {
      case (?_) {
        ignore Map.delete(featured, Text.compare, trackId);
        if (isOn) {
          Map.add(featured, Text.compare, trackId, true);
        };
      };
      case null { Runtime.trap("Track not found: " # trackId) };
    };
  };

  public query func listFeatured() : async [Text] {
    let entries = Map.entries(featured);
    let arr = Iter.toArray(entries);
    Array.map<(Text, Bool), Text>(arr, func((id, _)) = id)
  };

  // ── Play Counts ────────────────────────────────────────────────────────────
  // 30-second cooldown per principal to prevent inflation via repeated calls
  let PLAY_COOLDOWN_NS : Int = 30_000_000_000;

  public shared(msg) func recordPlay(trackId : Text, listenerId : Text) : async () {
    // Verify track exists
    switch (Map.get(tracks, Text.compare, trackId)) {
      case null { return };  // silently no-op for missing tracks
      case _ {};
    };

    // Per-principal-per-track cooldown (composite key prevents suppressing
    // legitimate plays when users quickly switch between different tracks)
    let now = Time.now();
    let rateKey = Principal.toText(msg.caller) # ":" # trackId;
    switch (Map.get(playRateLimit, Text.compare, rateKey)) {
      case (?prev) { if (now - prev < PLAY_COOLDOWN_NS) return };
      case null {};
    };
    playRateLimitCounter := updateTimestampText(
      playRateLimit, playRateLimitOrder, playRateLimitReverse,
      MAX_PLAY_RATE_LIMIT, playRateLimitCounter, rateKey, now
    );

    // Track unique listeners (only if listenerId is non-empty and reasonable length)
    if (Text.size(listenerId) > 0 and Text.size(listenerId) <= 64) {
      // Global unique set — write-once, skip if already present
      switch (Map.get(uniqueListeners, Text.compare, listenerId)) {
        case null {
          uniqueListenersCounter := addWriteOnceText(
            uniqueListeners, uniqueListenersOrder, uniqueListenersReverse,
            MAX_UNIQUE_LISTENERS, uniqueListenersCounter, listenerId
          );
        };
        case _ {};
      };
      // Per-track unique set — write-once, skip if already present
      let trackKey = listenerId # ":" # trackId;
      switch (Map.get(uniqueListenersPerTrack, Text.compare, trackKey)) {
        case null {
          uniqueListenersPerTrackCounter := addWriteOnceText(
            uniqueListenersPerTrack, uniqueListenersPerTrackOrder, uniqueListenersPerTrackReverse,
            MAX_UNIQUE_LISTENERS_PER_TRACK, uniqueListenersPerTrackCounter, trackKey
          );
        };
        case _ {};
      };
    };

    // Increment counters
    let prev = switch (Map.get(playCounts, Text.compare, trackId)) {
      case (?n) n;
      case null 0;
    };
    ignore Map.delete(playCounts, Text.compare, trackId);
    Map.add(playCounts, Text.compare, trackId, prev + 1);
    totalPlays += 1;

    // Append to rolling log, evicting oldest if over cap
    let existing = switch (Map.get(playLog, Text.compare, trackId)) {
      case (?arr) arr;
      case null [];
    };
    let appended = Array.tabulate<Int>(existing.size() + 1, func(i) {
      if (i < existing.size()) existing[i] else now
    });
    let trimmed = if (appended.size() > MAX_PLAY_LOG_PER_TRACK) {
      let drop = appended.size() - MAX_PLAY_LOG_PER_TRACK;
      Array.tabulate<Int>(MAX_PLAY_LOG_PER_TRACK, func(i) = appended[i + drop])
    } else {
      appended
    };
    ignore Map.delete(playLog, Text.compare, trackId);
    Map.add(playLog, Text.compare, trackId, trimmed);
  };

  public query func getPlayLog(trackId : Text) : async [Int] {
    switch (Map.get(playLog, Text.compare, trackId)) {
      case (?arr) arr;
      case null [];
    }
  };

  public query func getAllPlayCounts() : async [(Text, Nat)] {
    Iter.toArray(Map.entries(playCounts))
  };

  public query func getPlayCount(trackId : Text) : async Nat {
    switch (Map.get(playCounts, Text.compare, trackId)) {
      case (?n) n;
      case null 0;
    }
  };

  // ── Tomato Button ───────────────────────────────────────────────────────────

  public shared(msg) func throwTomato(trackId : Text, listenerId : Text) : async () {
    // W1.4: reject anonymous principals to prevent `listenerId`-rotation spam
    // that inflates `tomatoDedup` without cost. Browser-side tomato throwing
    // uses Internet Identity and never lands anonymously once II is wired up;
    // anonymous callers here would indicate a script bypassing the frontend.
    if (Principal.isAnonymous(msg.caller)) return;
    // W1.4: apply the per-principal rate limit shared with comments/guestbook
    // so rapid tomato mashing from one principal can't fan out into the dedup
    // map faster than the caps can evict.
    checkRateLimit(msg.caller);

    switch (Map.get(tracks, Text.compare, trackId)) {
      case null { return };
      case _ {};
    };
    // One tomato per listener per track
    if (Text.size(listenerId) == 0 or Text.size(listenerId) > 64) return;
    let dedupKey = listenerId # ":" # trackId;
    switch (Map.get(tomatoDedup, Text.compare, dedupKey)) {
      case (?_) { return };  // already threw a tomato
      case null {};
    };
    // W1.3: bounded insert via the eviction helper
    tomatoDedupCounter := addWriteOnceText(
      tomatoDedup, tomatoDedupOrder, tomatoDedupReverse,
      MAX_TOMATO_DEDUP, tomatoDedupCounter, dedupKey
    );

    let prev = switch (Map.get(tomatoCounts, Text.compare, trackId)) {
      case (?n) n;
      case null 0;
    };
    ignore Map.delete(tomatoCounts, Text.compare, trackId);
    Map.add(tomatoCounts, Text.compare, trackId, prev + 1);
  };

  public query func getAllTomatoCounts() : async [(Text, Nat)] {
    Iter.toArray(Map.entries(tomatoCounts))
  };

  // ── Video API (W2) ────────────────────────────────────────────────────────
  // Admin-only upload + finalize + delete + retroactive storageLocation moves.
  // Queries for listing + resume-safe upload progress.
  //
  // Invariants enforced here:
  //   - `videoId == "v-" # trackId` at finalize time (1:1 with audio track)
  //   - Every non-final chunk is exactly `chunkSize` bytes; the final chunk is
  //     `totalSize - (totalChunks-1)*chunkSize` and must be in (0, chunkSize]
  //   - `Map.size(videos) <= MAX_VIDEOS` on create
  //   - `totalSize <= MAX_VIDEO_SIZE_BYTES`, `totalChunks <= MAX_CHUNKS_PER_VARIANT`
  //   - `index < MAX_CHUNKS_PER_VARIANT` on upload
  //   - `data.size() <= VIDEO_CHUNK_SIZE_DEFAULT` on upload (protocol ceiling)

  func projectVideo(core : VideoCore) : VideoInfo {
    {
      id          = core.id;
      trackId     = core.trackId;
      durationSec = core.durationSec;
      variants    = Iter.toArray(Map.entries(core.variants));
      createdAt   = core.createdAt;
    }
  };

  public shared(msg) func uploadVideoChunk(
    videoId    : Text,
    resolution : Text,
    index      : Nat,
    chunkSize  : Nat,
    data       : Blob
  ) : async () {
    requireAdmin(msg.caller);
    if (index >= MAX_CHUNKS_PER_VARIANT) {
      Runtime.trap("chunk index exceeds MAX_CHUNKS_PER_VARIANT")
    };
    if (chunkSize == 0 or chunkSize > VIDEO_CHUNK_SIZE_DEFAULT) {
      Runtime.trap("chunkSize out of range")
    };
    if (data.size() == 0 or data.size() > chunkSize) {
      Runtime.trap("chunk data size out of range")
    };
    // NOTE: we cannot enforce data.size() == chunkSize here because the final
    // chunk is allowed to be smaller. The strict per-chunk check happens in
    // finalizeVideoVariant once totalChunks is known.
    let key = videoChunkKey(videoId, resolution, index);
    ignore Map.delete(chunks, Text.compare, key);
    Map.add(chunks, Text.compare, key, data);
  };

  public shared(msg) func finalizeVideoVariant(
    videoId         : Text,
    trackId         : Text,
    resolution      : Text,
    totalChunks     : Nat,
    chunkSize       : Nat,
    totalSize       : Nat,
    mimeType        : Text,
    storageLocation : StorageLocation,
    durationSec     : Nat
  ) : async () {
    requireAdmin(msg.caller);

    // Invariant: videoId must derive from trackId
    if (videoId != "v-" # trackId) {
      Runtime.trap("videoId must equal \"v-\" # trackId")
    };
    switch (Map.get(tracks, Text.compare, trackId)) {
      case null { Runtime.trap("Track not found: " # trackId) };
      case _ {};
    };
    if (totalSize > MAX_VIDEO_SIZE_BYTES) {
      Runtime.trap("totalSize exceeds MAX_VIDEO_SIZE_BYTES")
    };
    if (totalChunks == 0 or totalChunks > MAX_CHUNKS_PER_VARIANT) {
      Runtime.trap("totalChunks out of range")
    };
    if (chunkSize == 0 or chunkSize > VIDEO_CHUNK_SIZE_DEFAULT) {
      Runtime.trap("chunkSize out of range")
    };

    // Compute expected final-chunk size and verify the math is consistent.
    // totalSize must be in ((totalChunks-1)*chunkSize, totalChunks*chunkSize].
    let priorBytes : Nat = (totalChunks - 1) * chunkSize;
    if (totalSize <= priorBytes) {
      Runtime.trap("totalSize too small for totalChunks * chunkSize")
    };
    let finalChunkSize : Nat = totalSize - priorBytes;
    if (finalChunkSize > chunkSize) {
      Runtime.trap("finalChunkSize exceeds chunkSize")
    };

    // Verify every chunk is present and sized correctly.
    var i : Nat = 0;
    while (i < totalChunks) {
      let key = videoChunkKey(videoId, resolution, i);
      let expected : Nat = if (i + 1 == totalChunks) { finalChunkSize } else { chunkSize };
      switch (Map.get(chunks, Text.compare, key)) {
        case null { Runtime.trap("missing chunk " # Nat.toText(i)) };
        case (?blob) {
          if (blob.size() != expected) {
            Runtime.trap("chunk " # Nat.toText(i) # " size mismatch")
          };
        };
      };
      i += 1;
    };

    let variant : VideoVariant = {
      resolution;
      size        = totalSize;
      totalChunks;
      chunkSize;
      mimeType;
      storageLocation;
    };

    // Upsert the video record. New video: enforce MAX_VIDEOS cap.
    switch (Map.get(videos, Text.compare, videoId)) {
      case (?existing) {
        // Update existing: replace or add variant at this resolution.
        ignore Map.delete(existing.variants, Text.compare, resolution);
        Map.add(existing.variants, Text.compare, resolution, variant);
        // VideoCore is a record of stable fields + mutable inner map; no
        // need to reinsert into `videos` because `existing.variants` is the
        // same Map reference as the one in storage.
      };
      case null {
        if (Map.size(videos) >= MAX_VIDEOS) {
          Runtime.trap("MAX_VIDEOS reached")
        };
        let newVariants : Map.Map<Text, VideoVariant> = Map.empty();
        Map.add(newVariants, Text.compare, resolution, variant);
        let core : VideoCore = {
          id          = videoId;
          trackId;
          durationSec;
          variants    = newVariants;
          createdAt   = Time.now();
        };
        Map.add(videos, Text.compare, videoId, core);
      };
    };
  };

  public shared(msg) func cancelVideoUpload(videoId : Text, resolution : Text) : async () {
    requireAdmin(msg.caller);
    var i : Nat = 0;
    while (i < MAX_CHUNKS_PER_VARIANT) {
      ignore Map.delete(chunks, Text.compare, videoChunkKey(videoId, resolution, i));
      i += 1;
    };
  };

  public query func getVideoUploadProgress(videoId : Text, resolution : Text) : async [Nat] {
    // Returns sorted chunk indices currently present for this upload. Used by
    // the uploader to resume after a dropped call.
    let out = VarArray.repeat<Bool>(false, MAX_CHUNKS_PER_VARIANT);
    var count : Nat = 0;
    var i : Nat = 0;
    while (i < MAX_CHUNKS_PER_VARIANT) {
      switch (Map.get(chunks, Text.compare, videoChunkKey(videoId, resolution, i))) {
        case (?_) { out[i] := true; count += 1 };
        case null {};
      };
      i += 1;
    };
    let result = VarArray.repeat<Nat>(0, count);
    var j : Nat = 0;
    var k : Nat = 0;
    while (j < MAX_CHUNKS_PER_VARIANT) {
      if (out[j]) { result[k] := j; k += 1 };
      j += 1;
    };
    Array.fromVarArray<Nat>(result)
  };

  public shared(msg) func deleteVideo(videoId : Text) : async () {
    requireAdmin(msg.caller);
    switch (Map.get(videos, Text.compare, videoId)) {
      case (?core) {
        for ((resolution, variant) in Map.entries(core.variants)) {
          var i : Nat = 0;
          while (i < variant.totalChunks) {
            ignore Map.delete(chunks, Text.compare, videoChunkKey(videoId, resolution, i));
            i += 1;
          };
        };
        ignore Map.delete(videos, Text.compare, videoId);
      };
      case null {};
    };
  };

  public shared(msg) func setVideoStorageLocation(
    videoId    : Text,
    resolution : Text,
    location   : StorageLocation
  ) : async () {
    requireAdmin(msg.caller);
    switch (Map.get(videos, Text.compare, videoId)) {
      case null { Runtime.trap("Video not found: " # videoId) };
      case (?core) {
        switch (Map.get(core.variants, Text.compare, resolution)) {
          case null { Runtime.trap("Variant not found: " # resolution) };
          case (?old) {
            let updated : VideoVariant = {
              resolution      = old.resolution;
              size            = old.size;
              totalChunks     = old.totalChunks;
              chunkSize       = old.chunkSize;
              mimeType        = old.mimeType;
              storageLocation = location;
            };
            ignore Map.delete(core.variants, Text.compare, resolution);
            Map.add(core.variants, Text.compare, resolution, updated);
          };
        };
      };
    };
  };

  public query func listVideos() : async [VideoInfo] {
    Iter.toArray(
      Iter.map<(Text, VideoCore), VideoInfo>(
        Map.entries(videos),
        func((_id, core)) = projectVideo(core)
      )
    )
  };

  public query func getVideo(videoId : Text) : async ?VideoInfo {
    switch (Map.get(videos, Text.compare, videoId)) {
      case (?core) ?projectVideo(core);
      case null null;
    }
  };

  public query func getVideosByTrack(trackId : Text) : async [VideoInfo] {
    Iter.toArray(
      Iter.map<(Text, VideoCore), VideoInfo>(
        Iter.filter<(Text, VideoCore)>(
          Map.entries(videos),
          func((_id, core)) = core.trackId == trackId
        ),
        func((_id, core)) = projectVideo(core)
      )
    )
  };

  // ── Dashboard Stats ────────────────────────────────────────────────────────

  public type TrackPlayInfo = {
    trackId : Text;
    name    : Text;
    artist  : Text;
    plays   : Nat;
  };

  public type Stats = {
    totalTracks    : Nat;
    totalPlays     : Nat;
    totalComments  : Nat;
    totalGuestbook : Nat;
    uniqueListeners: Nat;
    topPlayed      : [TrackPlayInfo];
  };

  public query func getStats() : async Stats {
    // Build TrackPlayInfo array
    let entries = Map.entries(tracks);
    let arr = Iter.toArray(entries);
    let withPlays = Array.map<(Text, TrackCore), TrackPlayInfo>(arr, func((id, core)) {
      let extra = getExtra(id);
      let plays = switch (Map.get(playCounts, Text.compare, id)) {
        case (?n) n;
        case null 0;
      };
      { trackId = id; name = core.name; artist = extra.artist; plays = plays }
    });
    // Sort descending by plays
    let sorted = Array.sort<TrackPlayInfo>(withPlays, func(a, b) {
      Nat.compare(b.plays, a.plays)
    });
    // Take top 10
    let topN = if (sorted.size() > 10) {
      Array.tabulate<TrackPlayInfo>(10, func(i) = sorted[i])
    } else {
      sorted
    };

    // Sum comments across all tracks
    var commentsSum : Nat = 0;
    let commentEntries = Map.entries(comments);
    for ((_, arr) in commentEntries) {
      commentsSum += arr.size();
    };

    {
      totalTracks    = Map.size(tracks);
      totalPlays     = totalPlays;
      totalComments  = commentsSum;
      totalGuestbook = guestbook.size();
      uniqueListeners = Map.size(uniqueListeners);
      topPlayed      = topN;
    }
  };

  // Returns all comments across all tracks, with track context.
  // Admin-gated since this is for the dashboard.
  public type CommentWithContext = {
    trackId   : Text;
    trackName : Text;
    id        : Text;
    author    : Text;
    text      : Text;
    createdAt : Int;
  };

  public query(msg) func getAllComments() : async [CommentWithContext] {
    if (not isAdmin(msg.caller)) Runtime.trap("Unauthorized");
    let result = Array.flatten<CommentWithContext>(
      Array.map<(Text, [Comment]), [CommentWithContext]>(
        Iter.toArray(Map.entries(comments)),
        func((trackId, arr)) {
          let trackName = switch (Map.get(tracks, Text.compare, trackId)) {
            case (?core) core.name;
            case null "(deleted track)";
          };
          Array.map<Comment, CommentWithContext>(arr, func(c) {
            { trackId = trackId; trackName = trackName; id = c.id;
              author = c.author; text = c.text; createdAt = c.createdAt }
          })
        }
      )
    );
    // Sort newest first
    Array.sort<CommentWithContext>(result, func(a, b) {
      Int.compare(b.createdAt, a.createdAt)
    })
  };

  // ── Query API ──────────────────────────────────────────────────────────────

  public query func getTrack(trackId : Text) : async ?TrackInfo {
    switch (Map.get(tracks, Text.compare, trackId)) {
      case (?core) ?mergeTrack(core, getExtra(trackId));
      case null null;
    }
  };

  public query func listTracks() : async [TrackInfo] {
    let active = Map.size(tracks);
    if (active == 0) return [];
    // Collect all tracks by iterating the tracks map directly (avoids trackOrder gaps)
    let entries = Map.entries(tracks);
    let arr = Iter.toArray(entries);
    let result = Array.map<(Text, TrackCore), TrackInfo>(arr, func((trackId, core)) {
      mergeTrack(core, getExtra(trackId))
    });
    // Sort by order field
    Array.sort<TrackInfo>(result, func(a, b) {
      Nat.compare(a.order, b.order)
    })
  };

  public query func getCoverArt(trackId : Text) : async ?Blob {
    Map.get(coverArts, Text.compare, trackId)
  };

  public query func getChunk(trackId : Text, chunkIndex : Nat) : async ?Blob {
    Map.get(chunks, Text.compare, chunkKey(trackId, chunkIndex))
  };

  public query func trackCountQuery() : async Nat {
    Map.size(tracks)
  };

  // ── Comments API ──────────────────────────────────────────────────────────

  public shared(msg) func addComment(trackId : Text, author : Text, text : Text) : async () {
    switch (Map.get(tracks, Text.compare, trackId)) {
      case null { Runtime.trap("Track not found") };
      case _ {};
    };
    validateBody(text);
    let authorName = validateAuthor(author);
    checkRateLimit(msg.caller);

    let commentId = "c-" # Nat.toText(commentCount);
    commentCount += 1;
    let comment : Comment = {
      id        = commentId;
      author    = authorName;
      text      = text;
      createdAt = Time.now();
    };
    let existing = switch (Map.get(comments, Text.compare, trackId)) {
      case (?arr) arr;
      case null [];
    };
    // Cap: keep newest MAX_COMMENTS_PER_TRACK; evict oldest by sliding window
    let appended = Array.tabulate<Comment>(existing.size() + 1, func(i) {
      if (i < existing.size()) existing[i] else comment
    });
    let trimmed = if (appended.size() > MAX_COMMENTS_PER_TRACK) {
      let drop = appended.size() - MAX_COMMENTS_PER_TRACK;
      Array.tabulate<Comment>(MAX_COMMENTS_PER_TRACK, func(i) = appended[i + drop])
    } else {
      appended
    };
    ignore Map.delete(comments, Text.compare, trackId);
    Map.add(comments, Text.compare, trackId, trimmed);
  };

  public query func getComments(trackId : Text) : async [Comment] {
    switch (Map.get(comments, Text.compare, trackId)) {
      case (?arr) arr;
      case null [];
    }
  };

  public shared(msg) func deleteComment(trackId : Text, commentId : Text) : async () {
    requireAdmin(msg.caller);
    switch (Map.get(comments, Text.compare, trackId)) {
      case (?arr) {
        let filtered = Array.filter<Comment>(arr, func(c) = c.id != commentId);
        ignore Map.delete(comments, Text.compare, trackId);
        Map.add(comments, Text.compare, trackId, filtered);
      };
      case null {};
    };
    // Also clean up any replies to the deleted comment
    ignore Map.delete(replies, Text.compare, commentId);
  };

  // ── Reply API ─────────────────────────────────────────────────────────────

  public shared(msg) func replyToComment(commentId : Text, text : Text) : async () {
    requireAdmin(msg.caller);
    if (Text.size(text) == 0 or Text.size(text) > 500) {
      Runtime.trap("Reply must be 1-500 characters")
    };
    let replyId = "r-" # Nat.toText(replyCount);
    replyCount += 1;
    let reply : Reply = {
      id        = replyId;
      author    = "Cloud Records";
      text      = text;
      createdAt = Time.now();
    };
    let existing = switch (Map.get(replies, Text.compare, commentId)) {
      case (?arr) arr;
      case null [];
    };
    let updated = Array.tabulate<Reply>(existing.size() + 1, func(i) {
      if (i < existing.size()) existing[i] else reply
    });
    ignore Map.delete(replies, Text.compare, commentId);
    Map.add(replies, Text.compare, commentId, updated);
  };

  public query func getReplies(commentId : Text) : async [Reply] {
    switch (Map.get(replies, Text.compare, commentId)) {
      case (?arr) arr;
      case null [];
    }
  };

  // Batch query: all replies across all comments (for dashboard)
  public query(msg) func getAllReplies() : async [(Text, [Reply])] {
    if (not isAdmin(msg.caller)) Runtime.trap("Unauthorized");
    Iter.toArray(Map.entries(replies))
  };

  // ── Guestbook API ─────────────────────────────────────────────────────────

  public shared(msg) func addGuestbookEntry(author : Text, text : Text) : async () {
    validateBody(text);
    let authorName = validateAuthor(author);
    checkRateLimit(msg.caller);

    let entryId = "g-" # Nat.toText(guestbookCount);
    guestbookCount += 1;
    let entry : GuestbookEntry = {
      id        = entryId;
      author    = authorName;
      text      = text;
      createdAt = Time.now();
    };
    let appended = Array.tabulate<GuestbookEntry>(guestbook.size() + 1, func(i) {
      if (i < guestbook.size()) guestbook[i] else entry
    });
    // Cap: keep newest MAX_GUESTBOOK_ENTRIES
    guestbook := if (appended.size() > MAX_GUESTBOOK_ENTRIES) {
      let drop = appended.size() - MAX_GUESTBOOK_ENTRIES;
      Array.tabulate<GuestbookEntry>(MAX_GUESTBOOK_ENTRIES, func(i) = appended[i + drop])
    } else {
      appended
    };
  };

  public query func getGuestbook() : async [GuestbookEntry] {
    guestbook
  };

  public shared(msg) func deleteGuestbookEntry(entryId : Text) : async () {
    requireAdmin(msg.caller);
    guestbook := Array.filter<GuestbookEntry>(guestbook, func(e) = e.id != entryId);
  };

  // ── HTTP interface — serves cover art, OG metadata, and on-chain video ────

  type HttpRequest = {
    method  : Text;
    url     : Text;
    headers : [(Text, Text)];
    body    : Blob;
  };

  // Streaming types for video. `Token.resource` is `"v-<videoId>-<resolution>"`,
  // `Token.index` is the ABSOLUTE chunk index (0 = initial body in http_request,
  // 1+ = chunks yielded by http_request_streaming_callback). The callback MUST
  // NEVER TRAP — every unhappy path returns `{ body = ""; token = null }`.
  type Token = {
    resource : Text;
    index    : Nat;
  };

  type StreamingCallbackHttpResponse = {
    body  : Blob;
    token : ?Token;
  };

  type CallbackStrategy = {
    callback : shared query Token -> async StreamingCallbackHttpResponse;
    token    : Token;
  };

  type StreamingStrategy = {
    #Callback : CallbackStrategy;
  };

  type HttpResponse = {
    status_code        : Nat16;
    headers            : [(Text, Text)];
    body               : Blob;
    streaming_strategy : ?StreamingStrategy;
  };

  func textToBlob(t : Text) : Blob {
    Text.encodeUtf8(t)
  };

  // Extract track ID from URL path like /cover/track-123-abc
  func extractPath(url : Text) : Text {
    // Strip query string
    let parts = Text.split(url, #char '?');
    switch (parts.next()) {
      case (?path) path;
      case null url;
    }
  };

  // ── W2 Text parsing helpers ───────────────────────────────────────────────
  // Copy-pasted from video-range-test/src/main.mo (verified working 2026-04-15).
  // Used by the Range header parser and video path router. parseRange does NOT
  // apply VIDEO_MAX_SLICE — the caller clamps. Keeps parseRange reusable.

  func toLowerAscii(t : Text) : Text {
    Text.map(t, func(c : Char) : Char {
      if (c >= 'A' and c <= 'Z') {
        Char.fromNat32(Char.toNat32(c) + 32)
      } else { c }
    })
  };

  func trimWs(t : Text) : Text {
    Text.trim(t, #predicate(func(c : Char) : Bool {
      c == ' ' or c == '\t' or c == '\r' or c == '\n'
    }))
  };

  func parseNatT(t : Text) : ?Nat {
    let s = trimWs(t);
    if (s == "") { return null };
    var acc : Nat = 0;
    var any : Bool = false;
    for (c in s.chars()) {
      if (c < '0' or c > '9') { return null };
      let d : Nat = Nat32.toNat(Char.toNat32(c) - Char.toNat32('0'));
      acc := acc * 10 + d;
      any := true;
    };
    if (any) { ?acc } else { null }
  };

  func getHeader(headers : [(Text, Text)], name : Text) : ?Text {
    let target = toLowerAscii(name);
    for ((k, v) in headers.vals()) {
      if (toLowerAscii(k) == target) { return ?v };
    };
    null
  };

  // Parse `Range: bytes=<start>-<end>` with a full-response total size.
  // Returns (start, end) inclusive, both within [0, total-1]. Does NOT apply
  // any protocol-level clamp — caller is responsible for VIDEO_MAX_SLICE.
  // Returns null on malformed input or out-of-bounds.
  func parseRange(hv : Text, total : Nat) : ?(Nat, Nat) {
    let v = trimWs(hv);
    let lower = toLowerAscii(v);
    if (not Text.startsWith(lower, #text "bytes=")) { return null };
    let rest = switch (Text.stripStart(v, #text "bytes=")) {
      case (?r) r;
      case null {
        switch (Text.stripStart(lower, #text "bytes=")) {
          case (?r) r;
          case null { return null };
        }
      };
    };
    let spec = trimWs(rest);
    let parts = Iter.toArray(Text.split(spec, #char '-'));
    if (parts.size() != 2) { return null };
    let a = trimWs(parts[0]);
    let b = trimWs(parts[1]);

    if (a == "" and b == "") { return null };

    var startN : Nat = 0;
    var endN   : Nat = 0;

    if (a == "") {
      // Suffix range: bytes=-N = last N bytes
      switch (parseNatT(b)) {
        case (?n) {
          if (n == 0) { return null };
          let nClamped = if (n > total) { total } else { n };
          startN := total - nClamped;
          endN   := total - 1;
        };
        case null { return null };
      };
    } else if (b == "") {
      // Open-ended: bytes=S- = from S to end
      switch (parseNatT(a)) {
        case (?s) {
          if (s >= total) { return null };
          startN := s;
          endN   := total - 1;
        };
        case null { return null };
      };
    } else {
      switch (parseNatT(a), parseNatT(b)) {
        case (?s, ?e) {
          if (s >= total or e < s) { return null };
          startN := s;
          endN   := if (e >= total) { total - 1 } else { e };
        };
        case _ { return null };
      };
    };

    ?(startN, endN)
  };

  // Apply the VIDEO_MAX_SLICE clamp to a parsed range. Returns the clamped
  // (start, end) where end = min(requested end, start + VIDEO_MAX_SLICE - 1).
  func clampRangeToMaxSlice(s : Nat, e : Nat) : (Nat, Nat) {
    let span = e - s + 1;
    if (span > VIDEO_MAX_SLICE) {
      (s, s + VIDEO_MAX_SLICE - 1)
    } else {
      (s, e)
    }
  };

  // ── W2.5 readVideoRange — byte-range extraction without reassembly ────────
  // Walks the `chunks` map, pulls bytes from the chunks overlapping [absStart,
  // absEnd], returns the concatenated Blob. Never traps — returns empty Blob
  // on any missing chunk or out-of-bounds input so the callback + Range paths
  // can safely return empty responses to fuzzed or stale inputs.
  //
  // Assumes all non-final chunks are exactly `variant.chunkSize` bytes, which
  // is enforced by `finalizeVideoVariant`. The final chunk is allowed to be
  // smaller.
  func readVideoRange(
    variant   : VideoVariant,
    videoId   : Text,
    absStart  : Nat,
    absEnd    : Nat
  ) : Blob {
    if (variant.size == 0) return ("" : Blob);
    if (absStart >= variant.size) return ("" : Blob);
    let safeEnd : Nat = if (absEnd >= variant.size) { variant.size - 1 } else { absEnd };
    if (safeEnd < absStart) return ("" : Blob);
    let cs = variant.chunkSize;
    if (cs == 0) return ("" : Blob);

    // Chunk indices [firstChunk, lastChunk] (inclusive) overlap [absStart, safeEnd]
    let firstChunk : Nat = absStart / cs;
    let lastChunk  : Nat = safeEnd  / cs;
    let spanLen    : Nat = safeEnd - absStart + 1;

    // Fast path: entire range fits inside a single chunk.
    if (firstChunk == lastChunk) {
      let key = videoChunkKey(videoId, variant.resolution, firstChunk);
      switch (Map.get(chunks, Text.compare, key)) {
        case null { return ("" : Blob) };
        case (?blob) {
          let arr = Blob.toArray(blob);
          let localStart : Nat = absStart - firstChunk * cs;
          if (localStart >= arr.size()) return ("" : Blob);
          let localEnd   : Nat = if (localStart + spanLen > arr.size()) {
            arr.size()
          } else {
            localStart + spanLen
          };
          return Blob.fromArray(
            Array.tabulate<Nat8>(localEnd - localStart, func(i) = arr[localStart + i])
          );
        };
      };
    };

    // Multi-chunk path. At VIDEO_MAX_SLICE = 1.5 MB and chunkSize = 1.5 MB
    // the common case is 1–2 chunks. Build a Nat8 array by walking chunks.
    let out = VarArray.repeat<Nat8>(0, spanLen);
    var outIdx : Nat = 0;
    var chunkIdx : Nat = firstChunk;
    while (chunkIdx <= lastChunk and outIdx < spanLen) {
      let key = videoChunkKey(videoId, variant.resolution, chunkIdx);
      switch (Map.get(chunks, Text.compare, key)) {
        case null { return ("" : Blob) };  // defensive: missing chunk in finalized variant
        case (?blob) {
          let arr = Blob.toArray(blob);
          let chunkAbsStart : Nat = chunkIdx * cs;
          let localStart : Nat = if (absStart > chunkAbsStart) {
            absStart - chunkAbsStart
          } else { 0 };
          let chunkAbsEnd : Nat = chunkAbsStart + arr.size() - 1;  // inclusive
          let localEnd   : Nat = if (safeEnd < chunkAbsEnd) {
            safeEnd - chunkAbsStart + 1                            // exclusive bound
          } else {
            arr.size()
          };
          var i : Nat = localStart;
          while (i < localEnd and outIdx < spanLen) {
            out[outIdx] := arr[i];
            outIdx += 1;
            i += 1;
          };
        };
      };
      chunkIdx += 1;
    };

    Blob.fromArray(Array.fromVarArray<Nat8>(out))
  };

  // Escape a Text for safe interpolation inside an HTML attribute value.
  // Order matters: & must be replaced FIRST so the replacements for " < > don't
  // get double-encoded when they introduce new & characters.
  func escapeHtmlAttr(t : Text) : Text {
    let a = Text.replace(t, #text "&", "&amp;");
    let b = Text.replace(a, #text "\"", "&quot;");
    let c = Text.replace(b, #text "<", "&lt;");
    Text.replace(c, #text ">", "&gt;")
  };

  // ── W2.3 video route helpers ─────────────────────────────────────────────

  // Parse `/video/{videoId}/{resolution}` → (videoId, resolution). Returns
  // null on any malformed path or missing component. Video IDs and resolution
  // labels can contain hyphens; we split on the LAST `/` so "v-abc" + "480p"
  // round-trips correctly.
  func parseVideoPath(path : Text) : ?(Text, Text) {
    switch (Text.stripStart(path, #text "/video/")) {
      case null null;
      case (?rest) {
        // rest = "<videoId>/<resolution>"
        let segments = Iter.toArray(Text.split(rest, #char '/'));
        if (segments.size() != 2) return null;
        let videoId    = segments[0];
        let resolution = segments[1];
        if (videoId == "" or resolution == "") return null;
        ?(videoId, resolution)
      };
    }
  };

  // Produce a 404 response with a consistent shape, including streaming_strategy.
  func resp404() : HttpResponse {
    {
      status_code        = 404;
      headers            = [("Content-Type", "text/plain")];
      body               = textToBlob("Not found");
      streaming_strategy = null;
    }
  };

  public query func http_request(req : HttpRequest) : async HttpResponse {
    let path = extractPath(req.url);

    // Serve cover art: /cover/{trackId}
    if (Text.startsWith(path, #text "/cover/")) {
      let trackId = switch (Text.stripStart(path, #text "/cover/")) {
        case (?id) id;
        case null "";
      };
      switch (Map.get(coverArts, Text.compare, trackId)) {
        case (?artBlob) {
          let mimeType = switch (Map.get(trackExtras, Text.compare, trackId)) {
            case (?extra) if (extra.coverArtType != "") extra.coverArtType else "image/jpeg";
            case null "image/jpeg";
          };
          return {
            status_code = 200;
            headers = [
              ("Content-Type", mimeType),
              ("Cache-Control", "public, max-age=86400"),
              ("Access-Control-Allow-Origin", "*"),
            ];
            body = artBlob;
            streaming_strategy = null;
          };
        };
        case null {};
      };
    };

    // Serve OG HTML for shared tracks: /share/{trackId}
    if (Text.startsWith(path, #text "/share/")) {
      let trackId = switch (Text.stripStart(path, #text "/share/")) {
        case (?id) id;
        case null "";
      };
      switch (Map.get(tracks, Text.compare, trackId)) {
        case (?core) {
          let extra = getExtra(trackId);
          let frontendUrl = "https://kmeho-ciaaa-aaaae-ageza-cai.icp0.io/?track=" # trackId;
          let coverUrl = "https://kfhms-uaaaa-aaaae-ageyq-cai.raw.icp0.io/cover/" # trackId;
          let safeName   = escapeHtmlAttr(core.name);
          let safeArtist = escapeHtmlAttr(extra.artist);
          let safeAlbum  = escapeHtmlAttr(extra.album);
          let html = "<!DOCTYPE html><html><head>" #
            "<meta charset=\"UTF-8\">" #
            "<meta property=\"og:title\" content=\"" # safeName # " — Cloud Records\"/>" #
            "<meta property=\"og:description\" content=\"" # safeArtist # " · " # safeAlbum # " — Stream on-chain\"/>" #
            "<meta property=\"og:image\" content=\"" # coverUrl # "\"/>" #
            "<meta property=\"og:image:width\" content=\"500\"/>" #
            "<meta property=\"og:image:height\" content=\"500\"/>" #
            "<meta property=\"og:url\" content=\"" # frontendUrl # "\"/>" #
            "<meta property=\"og:type\" content=\"music.song\"/>" #
            "<meta name=\"twitter:card\" content=\"summary_large_image\"/>" #
            "<meta name=\"twitter:title\" content=\"" # safeName # " — Cloud Records\"/>" #
            "<meta name=\"twitter:image\" content=\"" # coverUrl # "\"/>" #
            "<meta http-equiv=\"refresh\" content=\"0;url=" # frontendUrl # "\"/>" #
            "</head><body>Redirecting...</body></html>";
          return {
            status_code = 200;
            headers = [
              ("Content-Type", "text/html"),
              ("Cache-Control", "public, max-age=300"),
            ];
            body = textToBlob(html);
            streaming_strategy = null;
          };
        };
        case null {};
      };
    };

    // Serve video: /video/{videoId}/{resolution}
    // Range + streaming_strategy are SEPARATE code paths per OpenChat's
    // production pattern. Range → 206 direct, NO streaming_strategy.
    // Non-Range → 200 + streaming_strategy callback, full Content-Length.
    if (Text.startsWith(path, #text "/video/")) {
      switch (parseVideoPath(path)) {
        case null { return resp404() };
        case (?(videoId, resolution)) {
          switch (Map.get(videos, Text.compare, videoId)) {
            case null { return resp404() };
            case (?core) {
              switch (Map.get(core.variants, Text.compare, resolution)) {
                case null { return resp404() };
                case (?variant) {
                  // Off-chain redirect branch — but never redirect to empty URL.
                  switch (variant.storageLocation) {
                    case (#offChain({ url; provider = _ })) {
                      if (url == "") { return resp404() };
                      return {
                        status_code        = 307;
                        headers            = [
                          ("Location", url),
                          ("Access-Control-Allow-Origin", "*"),
                        ];
                        body               = ("" : Blob);
                        streaming_strategy = null;
                      };
                    };
                    case (#onChain) {};
                  };

                  // On-chain serving path.
                  let total = variant.size;
                  let baseHeaders : [(Text, Text)] = [
                    ("Content-Type", variant.mimeType),
                    ("Accept-Ranges", "bytes"),
                    ("Cache-Control", "public, max-age=0"),
                    ("Access-Control-Allow-Origin", "*"),
                  ];

                  switch (getHeader(req.headers, "range")) {
                    case (?rv) {
                      // Range path: parse, clamp to VIDEO_MAX_SLICE, 206 direct.
                      switch (parseRange(rv, total)) {
                        case null {
                          // Malformed / out-of-bounds → 416 Range Not Satisfiable
                          return {
                            status_code        = 416;
                            headers            = Array.concat<(Text, Text)>(baseHeaders, [
                              ("Content-Length", "0"),
                              ("Content-Range", "bytes */" # Nat.toText(total)),
                            ]);
                            body               = ("" : Blob);
                            streaming_strategy = null;
                          };
                        };
                        case (?(s, e)) {
                          let (cs, ce) = clampRangeToMaxSlice(s, e);
                          let body = readVideoRange(variant, videoId, cs, ce);
                          let len  = ce - cs + 1;
                          return {
                            status_code        = 206;
                            headers            = Array.concat<(Text, Text)>(baseHeaders, [
                              ("Content-Length", Nat.toText(len)),
                              ("Content-Range",  "bytes " # Nat.toText(cs) # "-" # Nat.toText(ce) # "/" # Nat.toText(total)),
                            ]);
                            body               = body;
                            streaming_strategy = null;
                          };
                        };
                      };
                    };
                    case null {
                      // No-Range path: return first chunk + streaming_strategy
                      // for the rest. Content-Length is the FULL total size;
                      // the gateway assembles the stream behind that advertised
                      // length.
                      let firstEnd : Nat = if (total > 0 and total - 1 < VIDEO_MAX_SLICE - 1) {
                        total - 1
                      } else {
                        VIDEO_MAX_SLICE - 1
                      };
                      let firstBody = if (total == 0) {
                        ("" : Blob)
                      } else {
                        readVideoRange(variant, videoId, 0, firstEnd)
                      };
                      let needsStreaming : Bool = total > VIDEO_MAX_SLICE;
                      let strategy : ?StreamingStrategy = if (needsStreaming) {
                        ?(#Callback({
                          callback = http_request_streaming_callback;
                          token    = {
                            resource = "v-" # videoId # "-" # resolution;
                            index    = 1;   // absolute chunk index; 0 = initial body above
                          };
                        }))
                      } else { null };
                      return {
                        status_code        = 200;
                        headers            = Array.concat<(Text, Text)>(baseHeaders, [
                          ("Content-Length", Nat.toText(total)),
                        ]);
                        body               = firstBody;
                        streaming_strategy = strategy;
                      };
                    };
                  };
                };
              };
            };
          };
        };
      };
    };

    // 404
    resp404()
  };

  // ── W2.4 Streaming callback — NEVER TRAPS ─────────────────────────────────
  // Token.resource format: "v-<videoId>-<resolution>". Because videoId itself
  // starts with "v-", the full prefix is `"v-v-<trackId>-<resolution>"`. We
  // split on the LAST hyphen to recover resolution, and everything before
  // that is treated as the videoId. Any malformed token → empty body, null.
  //
  // Token.index is the ABSOLUTE chunk index (0 = initial http_request body,
  // 1+ = subsequent chunks served by this callback). The callback advances
  // by one chunk per call until the end of the variant.
  public shared query func http_request_streaming_callback(
    token : Token
  ) : async StreamingCallbackHttpResponse {
    let empty : StreamingCallbackHttpResponse = { body = ("" : Blob); token = null };

    // Must start with "v-" (video resource prefix)
    if (not Text.startsWith(token.resource, #text "v-")) return empty;

    // Strip the leading "v-" used by the scheme (not the videoId-internal "v-"),
    // then split the remainder on '-' to isolate the trailing resolution.
    // Format: "v-<videoId>-<resolution>" where videoId = "v-<trackId>".
    // Example: "v-v-track123-480p" → videoId = "v-track123", resolution = "480p"
    let rest = switch (Text.stripStart(token.resource, #text "v-")) {
      case (?r) r;
      case null { return empty };
    };
    let parts = Iter.toArray(Text.split(rest, #char '-'));
    if (parts.size() < 2) return empty;
    // resolution is the LAST segment; videoId is everything before it,
    // joined back with '-' and re-prefixed with "v-".
    let resolution = parts[parts.size() - 1];
    var videoIdInner : Text = "";
    var i : Nat = 0;
    while (i + 1 < parts.size()) {
      if (i == 0) { videoIdInner := parts[i] }
      else { videoIdInner := videoIdInner # "-" # parts[i] };
      i += 1;
    };
    let videoId = "v-" # videoIdInner;

    switch (Map.get(videos, Text.compare, videoId)) {
      case null { return empty };
      case (?core) {
        switch (Map.get(core.variants, Text.compare, resolution)) {
          case null { return empty };
          case (?variant) {
            // Guard against non-onChain serving (callback shouldn't fire for
            // off-chain redirects anyway, but be defensive).
            switch (variant.storageLocation) {
              case (#offChain(_)) { return empty };
              case (#onChain) {};
            };
            if (token.index == 0) return empty;  // index 0 is the initial body

            // Compute the byte range for this callback chunk. Each callback
            // invocation serves one slice of VIDEO_MAX_SLICE bytes starting
            // from (token.index) * VIDEO_MAX_SLICE. We model the whole file
            // as a sequence of VIDEO_MAX_SLICE-sized slices regardless of
            // the underlying chunkSize — the gateway assembles them in order.
            let sliceStart : Nat = token.index * VIDEO_MAX_SLICE;
            if (sliceStart >= variant.size) return empty;
            let sliceEnd : Nat = if (sliceStart + VIDEO_MAX_SLICE - 1 >= variant.size) {
              variant.size - 1
            } else {
              sliceStart + VIDEO_MAX_SLICE - 1
            };
            let body = readVideoRange(variant, videoId, sliceStart, sliceEnd);
            let isLast : Bool = sliceEnd + 1 >= variant.size;
            let nextToken : ?Token = if (isLast) {
              null
            } else {
              ?{ resource = token.resource; index = token.index + 1 }
            };
            { body; token = nextToken }
          };
        };
      };
    };
  };

};
