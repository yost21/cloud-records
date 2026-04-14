import Map "mo:core/Map";
import Text "mo:core/Text";
import Nat "mo:core/Nat";
import Int "mo:core/Int";
import Array "mo:core/Array";
import Time "mo:core/Time";
import Runtime "mo:core/Runtime";
import Principal "mo:core/Principal";
import Iter "mo:core/Iter";
import Blob "mo:core/Blob";

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
    ignore Map.delete(lastPostAt, Principal.compare, caller);
    Map.add(lastPostAt, Principal.compare, caller, now);
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

  public func setOrder(trackId : Text, newOrder : Nat) : async () {
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
    ignore Map.delete(playRateLimit, Text.compare, rateKey);
    Map.add(playRateLimit, Text.compare, rateKey, now);

    // Track unique listeners (only if listenerId is non-empty and reasonable length)
    if (Text.size(listenerId) > 0 and Text.size(listenerId) <= 64) {
      // Global unique set
      switch (Map.get(uniqueListeners, Text.compare, listenerId)) {
        case null { Map.add(uniqueListeners, Text.compare, listenerId, true) };
        case _ {};
      };
      // Per-track unique set
      let trackKey = listenerId # ":" # trackId;
      switch (Map.get(uniqueListenersPerTrack, Text.compare, trackKey)) {
        case null { Map.add(uniqueListenersPerTrack, Text.compare, trackKey, true) };
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

  public func throwTomato(trackId : Text, listenerId : Text) : async () {
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
    Map.add(tomatoDedup, Text.compare, dedupKey, true);

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

  // ── HTTP interface — serves cover art and OG metadata over HTTP ───────────

  type HttpRequest = {
    method  : Text;
    url     : Text;
    headers : [(Text, Text)];
    body    : Blob;
  };

  type HttpResponse = {
    status_code : Nat16;
    headers     : [(Text, Text)];
    body        : Blob;
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
          let html = "<!DOCTYPE html><html><head>" #
            "<meta charset=\"UTF-8\">" #
            "<meta property=\"og:title\" content=\"" # core.name # " — Cloud Records\"/>" #
            "<meta property=\"og:description\" content=\"" # extra.artist # " · " # extra.album # " — Stream on-chain\"/>" #
            "<meta property=\"og:image\" content=\"" # coverUrl # "\"/>" #
            "<meta property=\"og:image:width\" content=\"500\"/>" #
            "<meta property=\"og:image:height\" content=\"500\"/>" #
            "<meta property=\"og:url\" content=\"" # frontendUrl # "\"/>" #
            "<meta property=\"og:type\" content=\"music.song\"/>" #
            "<meta name=\"twitter:card\" content=\"summary_large_image\"/>" #
            "<meta name=\"twitter:title\" content=\"" # core.name # " — Cloud Records\"/>" #
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
          };
        };
        case null {};
      };
    };

    // 404
    {
      status_code = 404;
      headers = [("Content-Type", "text/plain")];
      body = textToBlob("Not found");
    }
  };

};
