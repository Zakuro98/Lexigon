# Lexigon Online

Lexigon now supports the existing local game plus server-authoritative online rooms and matches.

## What is implemented

### App flow

- **Local Play** opens the existing pass-the-device game.
- **Create Room** asks for a username, creates a four-character room code, and makes the creator the lobby host.
- **Join Room** asks for a username and room code.
- The lobby shows connected players and lets the host configure the match before starting.
- After an online match, the host can return everyone to the same lobby for another game.
- Each room has a shared chat available in both the lobby and during the match; its recent history carries across rematches while the room exists. The same chat also acts as the room activity log for joins/leaves, game starts, word plays, and turn changes.

### Server-authoritative online matches

Every player, including the room creator, connects to the same Node/WebSocket server. The creator is only the **lobby host**; their browser does not own the match.

The server owns and validates:

- player order and turn ownership
- Classic and Duel bags
- private player racks
- Classic scoring and modifiers
- Duel HP, base damage, additive special-tile boosts, and guaranteed special rewards
- word submissions and wildcard resolution
- pre-play discards
- skip-turn eligibility
- replacement draws
- Classic and Duel game-over conditions
- match history
- room chat attribution, length limits, relay, and server-generated activity messages

A client receives its **own rack only**. Opponents' racks are never sent to that browser.

The client still checks the dictionary and calculates a score/damage preview while tiles are selected so the interface stays instant. When Submit is pressed, the server reconstructs the word from the authoritative rack and independently validates and scores it. Client-side validation is therefore only a UX feature, not a trust boundary.

The server loads the same compressed dictionary embedded in `public/index.html`, including Lexigon's one-letter and extra-word additions, so client and server validation use the same word set.

## Project layout

```text
lexigon-online/
├── public/
│   └── index.html      # canonical Lexigon frontend
├── server.js           # room + authoritative match server
├── test-engine.js      # server rules smoke test
├── package.json
├── README.md
└── .gitignore
```

`public/index.html` is the frontend file to edit going forward.

## Run locally

Requires Node.js 20 or newer.

```bash
npm install
npm test
npm start
```

Then open:

```text
http://localhost:3000
```

Open it in two or more browser windows to create/join a room and test an online match.

The local server serves both the frontend and the WebSocket endpoint, so `ONLINE_SERVER_ORIGIN` in `public/index.html` should remain blank for local development.

## Hosting

The frontend can be hosted as a static site (for example, GitHub Pages), while `server.js` runs on a public Node host such as Render. No player—including you—needs to port-forward their router.

When the frontend and server are hosted separately, set this near the start of the main script in `public/index.html`:

```js
const ONLINE_SERVER_ORIGIN = 'https://your-lexigon-server.example.com';
```

The client converts the HTTP(S) origin to the corresponding WebSocket URL and connects to `/ws`.

For example:

```text
GitHub Pages frontend
        │
        │ WebSocket
        ▼
public Node server (Render, etc.)
```

The Node server also serves `public/` itself, so using one host for both is supported too.

## Current limitations

- Rooms and games are held in server memory. Restarting the server removes active rooms.
- Reconnection/resuming after a dropped connection is not implemented yet. If someone leaves or disconnects during an active match, the match is aborted and the remaining connected players return to the room lobby.
- There are no accounts, matchmaking, ratings, spectators, or persistent match history yet.
- Room usernames are temporary and only need to be unique within that room.
- Chat history is temporary, held in room memory, and capped at the most recent 100 messages.

These are intentionally separate from the core authoritative multiplayer path, which is now in place.

## First public deployment: one Render web service

The simplest public setup is to deploy this entire repository as one Render Web Service. `server.js` serves both `public/index.html` and the `/ws` WebSocket endpoint, so the browser and multiplayer server share one origin.

For this setup, leave this unchanged in `public/index.html`:

```js
const ONLINE_SERVER_ORIGIN = '';
```

The browser automatically connects back to the same host using `wss://.../ws` when the public page is loaded over HTTPS.

This repository includes `render.yaml` with the required Node service configuration and `/health` endpoint. The server binds to `0.0.0.0` and uses Render's `PORT` environment variable automatically.

### Deploy

1. Put this `lexigon-online` folder in a Git repository and push it to GitHub.
2. In Render, create a new **Blueprint** and select that repository. Render reads `render.yaml` from the repository root.
3. Review the service and apply the Blueprint.
4. After deployment succeeds, open the generated `https://...onrender.com` URL.
5. Test from two unrelated networks if possible (for example, desktop Wi-Fi and a phone on cellular) to verify that the WebSocket connection is genuinely going over the internet.

You can also create the service manually as a **Web Service** instead of using a Blueprint. Use `npm install` as the build command, `npm start` as the start command, and `/health` as the health-check path.

### Important hosting behavior

Rooms, matches, and chat are still in process memory. A server restart or deploy therefore removes active rooms. Keep the service at one instance unless room state is later moved to shared storage. Reconnection/resume after a dropped connection is also not implemented yet, so a dropped player currently aborts an active match as described above.
