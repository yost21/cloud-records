import Map "mo:core/Map";
import Text "mo:core/Text";
import Nat "mo:core/Nat";
import Array "mo:core/Array";
import Time "mo:core/Time";
import Runtime "mo:core/Runtime";
import Principal "mo:core/Principal";
import Iter "mo:core/Iter";

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

  // ── Helpers ────────────────────────────────────────────────────────────────

  func chunkKey(trackId : Text, idx : Nat) : Text {
    trackId # ":" # Nat.toText(idx)
  };

  func defaultExtra() : TrackExtra {
    { artist = ""; album = ""; trackNumber = 0; coverArtType = "" }
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
        ignore Map.delete(trackOrder, Nat.compare, info.order);
        ignore Map.delete(tracks, Text.compare, trackId);
      };
      case null {};
    };
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

};
