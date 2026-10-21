# GNC-PRIME (AI Ground)

The user's own AI Ground: one chat front-end where several GNC-branded models
(GNC-1, GNC-Flash, GNC-Code, GNC-Think, GNC-Vision, GNC-Lite) are served by
free engines behind a fallback router, with per-user memory on
Neon Postgres (pgvector). Phase 1 scaffold: Chat Ground + Model Gateway (Step 1–2 of the
blueprint).

Blueprint: `~/workspace/your_files/ai-ground-phase1-blueprint-2026-10-21.md`

## Run locally

```bash
pnpm install
cp .env.example .env   # fill in real keys locally; never commit .env

# API (http://localhost:4000)
DEV_AUTH=1 pnpm dev:api

# Web (http://localhost:5173, proxies /api to the API)
pnpm dev:web
```

Health check: `curl http://localhost:4000/api/health` → `{ "ok": true }`

## Typecheck

```bash
pnpm --filter @gnc/api run check
pnpm --filter @gnc/web run check
```

## Notes

- No real credentials live in this repo. Keys come from environment variables
  only (`GEMINI_GROUND_API_KEY`, `OPENCODE_API_KEY`, `DATABASE_URL`,
  `JWT_SECRET`, `GOOGLE_CLIENT_ID`, `OWNER_EMAIL`).
- Own JWT auth (Build Step 3): `POST /api/auth/register`, `POST /api/auth/login`,
  `POST /api/auth/google` (needs `GOOGLE_CLIENT_ID`; unset → 501) and
  `GET /api/auth/me`. Chat and history (`/api/conversations`) require the
  Bearer token; signed-in chats persist to Neon with per-user memory
  (pgvector) and a daily free cap (`DAILY_MSG_CAP`; `OWNER_EMAIL` is exempt).
- The `DEV_AUTH=1` + `x-dev-user` bypass still exists for local dev, but is
  stateless: no DB, no history, no memory.
