import type { IDL } from "@dfinity/candid";

// Hand-written Candid IDL factory — mirrors backend/Main.mo's public interface.

export const idlFactory: IDL.InterfaceFactory = ({ IDL }) => {
  const TrackInfo = IDL.Record({
    id           : IDL.Text,
    name         : IDL.Text,
    artist       : IDL.Text,
    album        : IDL.Text,
    trackNumber  : IDL.Nat,
    mimeType     : IDL.Text,
    totalChunks  : IDL.Nat,
    size         : IDL.Nat,
    createdAt    : IDL.Int,
    order        : IDL.Nat,
    coverArtType : IDL.Text,
    featured     : IDL.Bool,
  });

  const Comment = IDL.Record({
    id        : IDL.Text,
    author    : IDL.Text,
    text      : IDL.Text,
    createdAt : IDL.Int,
  });

  const Reply = IDL.Record({
    id        : IDL.Text,
    author    : IDL.Text,
    text      : IDL.Text,
    createdAt : IDL.Int,
  });

  const GuestbookEntry = IDL.Record({
    id        : IDL.Text,
    author    : IDL.Text,
    text      : IDL.Text,
    createdAt : IDL.Int,
  });

  // Video types — mirror backend/Main.mo W2 additions.
  const StorageLocation = IDL.Variant({
    onChain  : IDL.Null,
    offChain : IDL.Record({ url: IDL.Text, provider: IDL.Text }),
  });
  const VideoVariant = IDL.Record({
    resolution      : IDL.Text,
    size            : IDL.Nat,
    totalChunks     : IDL.Nat,
    chunkSize       : IDL.Nat,
    mimeType        : IDL.Text,
    storageLocation : StorageLocation,
  });
  const VideoInfo = IDL.Record({
    id          : IDL.Text,
    trackId     : IDL.Text,
    durationSec : IDL.Nat,
    variants    : IDL.Vec(IDL.Tuple(IDL.Text, VideoVariant)),
    createdAt   : IDL.Int,
  });

  return IDL.Service({
    // Updates
    uploadChunk   : IDL.Func([IDL.Text, IDL.Nat, IDL.Vec(IDL.Nat8)], [], []),
    finalizeTrack : IDL.Func(
      [IDL.Text, IDL.Text, IDL.Text, IDL.Text, IDL.Nat, IDL.Nat, IDL.Text, IDL.Nat],
      [],
      []
    ),
    setCoverArt   : IDL.Func([IDL.Text, IDL.Vec(IDL.Nat8), IDL.Text], [], []),
    updateTrack   : IDL.Func([IDL.Text, IDL.Text, IDL.Text, IDL.Text, IDL.Nat], [], []),
    deleteTrack   : IDL.Func([IDL.Text], [], []),
    setOrder      : IDL.Func([IDL.Text, IDL.Nat], [], []),
    setFeatured   : IDL.Func([IDL.Text, IDL.Bool], [], []),
    listFeatured  : IDL.Func([], [IDL.Vec(IDL.Text)], ["query"]),
    recordPlay    : IDL.Func([IDL.Text, IDL.Text], [], []),
    throwTomato   : IDL.Func([IDL.Text, IDL.Text], [], []),
    getAllTomatoCounts : IDL.Func([], [IDL.Vec(IDL.Tuple(IDL.Text, IDL.Nat))], ["query"]),
    getPlayCount  : IDL.Func([IDL.Text], [IDL.Nat], ["query"]),
    getPlayLog    : IDL.Func([IDL.Text], [IDL.Vec(IDL.Int)], ["query"]),
    getAllPlayCounts : IDL.Func([], [IDL.Vec(IDL.Tuple(IDL.Text, IDL.Nat))], ["query"]),
    getStats      : IDL.Func([], [IDL.Record({
      totalTracks    : IDL.Nat,
      totalPlays     : IDL.Nat,
      totalComments  : IDL.Nat,
      totalGuestbook : IDL.Nat,
      uniqueListeners: IDL.Nat,
      topPlayed      : IDL.Vec(IDL.Record({
        trackId : IDL.Text,
        name    : IDL.Text,
        artist  : IDL.Text,
        plays   : IDL.Nat,
      })),
    })], ["query"]),
    getAllComments : IDL.Func([], [IDL.Vec(IDL.Record({
      trackId   : IDL.Text,
      trackName : IDL.Text,
      id        : IDL.Text,
      author    : IDL.Text,
      text      : IDL.Text,
      createdAt : IDL.Int,
    }))], ["query"]),
    // Admin
    addAdmin          : IDL.Func([IDL.Principal], [], []),
    removeAdmin       : IDL.Func([IDL.Principal], [], []),
    listAdmins        : IDL.Func([], [IDL.Vec(IDL.Principal)], ["query"]),
    isCallerAdmin     : IDL.Func([IDL.Principal], [IDL.Bool], ["query"]),
    // Comments
    addComment        : IDL.Func([IDL.Text, IDL.Text, IDL.Text], [], []),
    getComments       : IDL.Func([IDL.Text], [IDL.Vec(Comment)], ["query"]),
    deleteComment     : IDL.Func([IDL.Text, IDL.Text], [], []),
    replyToComment    : IDL.Func([IDL.Text, IDL.Text], [], []),
    getReplies        : IDL.Func([IDL.Text], [IDL.Vec(Reply)], ["query"]),
    getAllReplies      : IDL.Func([], [IDL.Vec(IDL.Tuple(IDL.Text, IDL.Vec(Reply)))], ["query"]),
    // Guestbook
    addGuestbookEntry : IDL.Func([IDL.Text, IDL.Text], [], []),
    getGuestbook      : IDL.Func([], [IDL.Vec(GuestbookEntry)], ["query"]),
    deleteGuestbookEntry : IDL.Func([IDL.Text], [], []),
    // Queries
    getTrack          : IDL.Func([IDL.Text], [IDL.Opt(TrackInfo)], ["query"]),
    listTracks        : IDL.Func([], [IDL.Vec(TrackInfo)],         ["query"]),
    getCoverArt       : IDL.Func([IDL.Text], [IDL.Opt(IDL.Vec(IDL.Nat8))], ["query"]),
    getChunk          : IDL.Func([IDL.Text, IDL.Nat], [IDL.Opt(IDL.Vec(IDL.Nat8))], ["query"]),
    trackCountQuery   : IDL.Func([], [IDL.Nat],                    ["query"]),
    // Video queries (W5)
    listVideos             : IDL.Func([], [IDL.Vec(VideoInfo)],                   ["query"]),
    getVideo               : IDL.Func([IDL.Text], [IDL.Opt(VideoInfo)],           ["query"]),
    getVideosByTrack       : IDL.Func([IDL.Text], [IDL.Vec(VideoInfo)],           ["query"]),
    getVideoUploadProgress : IDL.Func([IDL.Text, IDL.Text], [IDL.Vec(IDL.Nat)],   ["query"]),
  });
};
