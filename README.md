# ჯოკერი (Joker) — mobile web card game

```bash
npm install
npm start            # http://localhost:3000
npm test             # full 4-player simulated game
```

- The **first registered account is the admin** (or set `ADMIN_USERNAME=name` before the first start).
- Admin creates a table on the home page and sends the link (`/t/<code>`). Players register/log in, open the link and get a seat; the game starts automatically at 4 players.
- Data is stored in `data/` (override with `DATA_DIR`). Env: `PORT`, `TRICK_DELAY`, `DEAL_DELAY`.
- Rules/scoring live in `game.js` (`scoreFor`, `DEALS`, `legalPlays`).
