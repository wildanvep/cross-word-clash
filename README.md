# Crossword Clash: Team 4 English Day

A React and TypeScript crossword game for Team 4 English Day — Eco × Commercial. It includes a player screen, a password-protected host desk, listening clues, team scoring, and a round timer.

## Run locally

```bash
npm install
npm run dev
```

## Build for production

```bash
npm run build
npm run preview
```

The host password is set in the browser and stored there as a salted hash. The player and host screens share game state through browser storage, so this version is intended for use in tabs on the same browser; it does not include a server or cross-device synchronization.
