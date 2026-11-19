# Crossword Clash: Team 4 English Day

A React and TypeScript crossword game for Team 4 English Day — Eco × Commercial. It includes a player screen, an open Host Desk, listening clues, team scoring, and a round timer.

## Run locally

```bash
npm install
npm run dev
```

The Vite development server supports local play. Live rooms require the Vercel WebSocket function and a Redis connection; to test that locally, use `vercel dev` with `REDIS_URL` configured.

## Build for production

```bash
npm run build
npm run preview
```

## Enable live rooms on Vercel

Live rooms use Vercel Functions WebSockets and Upstash Redis. Both offer free plans; check their current quotas before an event.

1. Create a free Redis database in Upstash and copy its TLS Redis connection URL (`rediss://...`).
2. In the Vercel project settings, add that URL as `REDIS_URL` for the environments you use. Keep it private and do not commit it.
3. Ensure Fluid Compute is enabled for the Vercel project, then deploy or redeploy.
4. Open `/host` and choose **Create live room**. Copy the player link or share the displayed room code.
5. Open that link on the other laptop. The Host Desk stays authoritative; player screens receive the latest state and reconnect from Redis if their connection drops.

Rooms and their latest game state expire after 12 hours without activity. `REDIS_URL` is also documented in `.env.example`.

The Host Desk has no password gate. A separate room token, checked by the server, grants write access to the device that created the room; the player link does not include it. Without a room, the screens continue to use browser storage as before.
