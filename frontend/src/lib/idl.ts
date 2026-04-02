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
    // Admin
    addAdmin          : IDL.Func([IDL.Principal], [], []),
    removeAdmin       : IDL.Func([IDL.Principal], [], []),
    listAdmins        : IDL.Func([], [IDL.Vec(IDL.Principal)], ["query"]),
    isCallerAdmin     : IDL.Func([IDL.Principal], [IDL.Bool], ["query"]),
    // Queries
    getTrack          : IDL.Func([IDL.Text], [IDL.Opt(TrackInfo)], ["query"]),
    listTracks        : IDL.Func([], [IDL.Vec(TrackInfo)],         ["query"]),
    getCoverArt       : IDL.Func([IDL.Text], [IDL.Opt(IDL.Vec(IDL.Nat8))], ["query"]),
    getChunk          : IDL.Func([IDL.Text, IDL.Nat], [IDL.Opt(IDL.Vec(IDL.Nat8))], ["query"]),
    trackCountQuery   : IDL.Func([], [IDL.Nat],                    ["query"]),
  });
};
