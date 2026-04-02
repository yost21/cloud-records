# Cloud Records — Demo Video Script (60-90 seconds)

## Setup
- Screen recording via Screen Studio or QuickTime
- Browser open to https://kmeho-ciaaa-aaaae-ageza-cai.icp0.io/
- Terminal open in split (optional — for the wow factor)

---

## Script

### HOOK (0-5 sec)
*[Show the site loading with the tip jar banner visible]*
"I built a music platform where every single byte lives on the blockchain."

### THE SITE (5-20 sec)
*[Scroll through the playlist — show Originals and Covers sections]*
"This is Cloud Records. 13 tracks — originals and covers. Each one has album art, metadata, and full audio streaming."

*[Click play on a track — let it stream for a few seconds]*
"That audio you're hearing? It's not coming from AWS or a CDN. It's streaming directly from an ICP canister."

### THE ARCHITECTURE (20-35 sec)
*[Quick flash of the terminal — show `dfx canister status` or the Candid UI]*
"One Motoko canister handles everything. Chunk-based audio upload, metadata, cover art — all stored on-chain using the Internet Computer's orthogonal persistence."

*[Show the URL bar — kmeho-ciaaa-aaaae-ageza-cai.icp0.io]*
"Even the frontend is a certified asset canister. The whole app — backend logic, audio data, UI — is hosted entirely by the network. No servers."

### THE FEATURES (35-50 sec)
*[Show album grouping — collapse/expand an album]*
"Albums are grouped by Originals and Covers. You can drag to reorder."

*[Triple-click logo to show admin mode]*
"Admin mode lets me edit metadata, upload new tracks, and manage cover art — all protected by canister-level access control."

*[Show the cover art — Rumours, Dark Side of the Moon, your guitar photos]*
"Every cover art image is also stored on-chain. Fetched from the canister, rendered in the browser."

### THE BUILD (50-65 sec)
*[Quick flash of Main.mo in the editor — show the admin check code]*
"Built during the ICP AI Builder Sprint — 3 days, Claude Code as my copilot. Motoko backend, React frontend, deployed with the `icp` CLI."

### CTA (65-75 sec)
*[Back to the site, track still playing]*
"It's live right now. Link in the thread. Listen to my covers, roast my originals, and tell me what to build next."

*[Show the tip jar banner one more time]*
"And if you think I need a real producer... I agree."

---

## Key talking points if you go longer:
- **133MB → 25MB** by converting WAV to optimized MP3 (88% reduction)
- **Admin access control** — canister rejects non-admin update calls
- **Enhanced Orthogonal Persistence** — data survives canister upgrades without migration code
- **Zero infrastructure cost** — runs on cycles, not monthly AWS bills
- **Open source** — github.com/yost21/cloud-records

## Don't forget:
- Tag @dfinity, @anthropic, @claudeai
- Mention the ICP Builder Sprint and @pierre (if appropriate)
- Link the live site
- Link the GitHub repo
