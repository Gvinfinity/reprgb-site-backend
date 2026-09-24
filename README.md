# REP RGB backend

Express + TypeScript (ESM), PostgreSQL, Prisma 7, Zod/OpenAPI and Better Auth. The frontend in `../reprgb-site` uses these persistent APIs; no demonstration accounts or automatic sample-data fallback are enabled.

## Development

Use Node 24 LTS and PostgreSQL 17 or newer. Install dependencies in both sibling repositories.

```sh
cp .env.example .env
npm ci
npm run db:generate
npm run db:migrate
npm run admin:bootstrap
npm run dev
```

Set `DATABASE_URL` to a **fresh** PostgreSQL database, `APP_ORIGIN=http://localhost:3000`, and a random `BETTER_AUTH_SECRET` of at least 32 characters. Generate values with `openssl rand -hex 32`. Do not reuse the example placeholders. `db:seed` intentionally creates no accounts or fictional household data.

Start `npm run dev` in the frontend repository. Vite proxies `/api` and WebSockets to port 3001. Use the frontend origin for login and playback. Production builds use `npm run build` and `npm start`; run migrations before startup.

`admin:bootstrap` interactively creates the **first** administrator; passwords are hidden and no default password exists. `npm run admin:reset` changes an existing account's password and revokes its sessions. These commands require a terminal. Cameras revalidate sessions every 15 seconds, so CLI password resets also close existing streams within that interval.

## Local HTTPS deployment

`compose.yaml` runs PostgreSQL, the backend and a Caddy image built from the sibling frontend. It does not start or modify Frigate.

1. Copy `.env.example` to `.env`. Set a random, URL-safe `POSTGRES_PASSWORD`, `BETTER_AUTH_SECRET`, `SITE_HOST` (for example `rgb.home.arpa`) and matching `APP_ORIGIN` (`https://rgb.home.arpa`). Leave optional Frigate variables commented until configured.
2. Resolve that hostname to this server on your LAN. Keep the server restricted to the household network; internet exposure is outside this deployment.
3. Run `docker compose up --build -d`. Migrations run before the API starts. PostgreSQL has no published host port.
4. Run `docker compose exec backend node dist/cli.js bootstrap` interactively.
5. Install Caddy's local CA on household devices. Export it with `docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt ./rgb-local-ca.crt`. Trust that CA through each device's certificate settings. Keep Caddy's data volume, which contains the CA, private.
6. Check `https://rgb.home.arpa/api/health` and `/api/ready`, then sign in and open **Admin** to create resident profiles and invitations.

A changed `POSTGRES_PASSWORD` in `.env` does not change an existing database role's password. Rotate credentials deliberately. `docker compose down` preserves volumes; do not use `down -v` for an existing installation unless intentionally deleting its data.

## Accounts and permissions

Signup is invitation-only. Admin-generated links bind the email and resident, expire after seven days, and can be redeemed once. Only their SHA-256 hashes are stored. Creating a replacement invitation invalidates unused invitations for that resident. The UI shows pending/expired/used invitations; links are shown only at creation. There is no SMTP delivery, open signup, role picker or client-controlled resident identity.

Public readers can see task definitions, completion history, quotes, cinema and board-relevant resident names/colors/IDs. Signed-in residents can view cameras, claim any pending task for themselves (including another resident's task), return their own tasks, complete their own assigned tasks, and correct their own completion durations. Administrators manage all household data and can assign/return/complete any task. `/people` and legacy leaderboard APIs are admin-only. Accounts, invitations, imports and task audit events are private to administrators. Deactivating an **account** revokes login sessions; marking a resident profile historical controls its participation in new assignments and invitations.

Better Auth stores password hashes and cookie sessions in PostgreSQL. Account deactivation/session revocation also closes that user's streaming connections. Cookie sessions are secure on HTTPS, and mutation origins and WebSocket origins are checked.

## API and persistence

Application endpoints live under `/api/v1`; login/session/password operations use `/api/auth`. Admin API documentation is at `/api/v1/reference`, with JSON at `/api/v1/openapi.json`. Responses use `{error, requestId}` for errors. Logs contain request IDs, paths, methods and status codes, never request bodies, cookies, camera credentials or TMDB keys.

- `/me`, `/residents`, `/accounts`, `/invitations`, `/register`: identities, profiles and invitation registration.
- `/tasks`, `/tasks/:id/assignment`, `/tasks/:id/archive`, `/tasks/:id/completions`: versioned task mutations. Send the current `version`; stale writes return `409`. Completion requires a UUID `Idempotency-Key`, reused when retrying the **same** request.
- `/completions`, `/completions/:id`: history and versioned duration corrections. `/tasks/:id/events` is admin-only and records creation, edits, reassignment, return, completion, archival and corrections with their actors.
- `/quotes`: public accent-insensitive search (`q`) and admin CRUD.
- `/quote-imports`: admin multipart TXT upload (`file`, UTF-8, at most 1 MiB), list and detail/preview. A successful upload returns `202`, an ID and `awaiting_parser`; identical files return the existing ID. Uploading **never creates quotes**. Content, checksum, uploader and timestamp are stored in PostgreSQL. `QuoteParser` defines the future draft interface; there is no parser, AI execution, worker or automatic publication yet.
- `/screenings`: public listings, admin creation/editing; separate persisted Movie and Screening records. `/movies/search?q=...` and `/movies/tmdb/:id` are admin-only TMDB metadata lookups in Portuguese. Set the server-only TMDB v3 API key. Search is cached for five minutes; TMDB failure leaves saved listings and manual entry usable. Attribution appears in CineRGB credits.
- `/data-imports/preview` and `/data-imports/commit`: administrative browser-data migration, described below.

Calendar task deadlines are PostgreSQL `date` values, due through the end of the scheduled day in `America/Sao_Paulo`. Completion timestamps are UTC instants. Weekly schedules support multiple days; fortnightly schedules retain their anchor; monthly schedules clamp to the month's final day without changing the requested day. Completing early advances beyond the next scheduled occurrence; completing late clears the overdue occurrence and advances to the next future fixed date, without accumulating missed repetitions. One-off tasks become completed. Archival retains completion snapshots, performing resident, recorded minutes/weight and audit events. Deadline advancement and completion insertion are one transaction.

## Frigate MSE

Use the existing Frigate instance with its configured streams. Set, for example:

```dotenv
FRIGATE_URL=https://frigate.home.arpa:8971/
FRIGATE_AUTH_MODE=account
FRIGATE_USERNAME=reprgb-viewer
FRIGATE_PASSWORD=your-frigate-password
FRIGATE_CAMERAS=[{"id":"entrada","name":"Entrada","location":"Porta da casa","stream":"front"},{"id":"quintal","name":"Quintal","location":"Fundos","stream":"yard"}]
# For a private certificate authority, mount its PEM and set this path:
# FRIGATE_CA_FILE=/run/secrets/frigate-ca.pem
```

Alternatively, explicitly set `FRIGATE_AUTH_MODE=internal` with a trusted, network-restricted internal Frigate URL (typically port 5000). Do not use that endpoint on an untrusted network. REP RGB still authenticates every browser stream. Account mode logs into `/api/login`, retains the Frigate token server-side and refreshes it when expired; it **never** falls back to internal mode. TLS verification stays enabled, with an optional configured CA.

Authenticated `GET /api/v1/cameras` returns public camera metadata. WebSocket `/api/v1/cameras/:id/mse` requires a current session and the exact application origin. Camera IDs resolve only through the server allowlist to Frigate `/live/mse/api/ws?src=...`; no client-selected destinations or management API are proxied. Only MSE negotiation and upstream media are relayed. Caddy carries this over the same HTTPS/WSS origin. No RTSP connection, second go2rtc, WebRTC, STUN/TURN, transcoder or extra browser-facing media port is deployed.

The camera grid starts disabled; the homepage enables one selected camera after login. Closing, disabling, switching, navigating away or logging out releases its socket/MSE resources. Expanded viewing suspends that camera's grid player. The player limits pending media to 8 MiB, trims old buffered video, catches up to the live edge, and makes three bounded reconnect attempts before offering manual retry. Unsupported MSE/codecs show an explicit error. Playback controls never modify Frigate recording or detection.

After supplying actual household configuration, smoke-test each mapped stream, both grid/expanded views, turning feeds off, logout and account revocation. Confirm Frigate recording continues independently. The automated compatible-source test cannot establish compatibility with an unspecified real Frigate version, TLS setup or camera codec.

## Import the existing browser data

The frontend leaves `reprgb.demo.v3` untouched. Before changing hostnames/origins, open **Exportar dados anteriores** on the original origin/browser and download its JSON. If that frontend is no longer available, use its browser developer tools to copy the local-storage value into a JSON file. Browser storage is isolated by origin.

In **Admin → Importar dados do navegador**, select the JSON and explicitly map every old resident identifier to a real profile. Create historical inactive profiles without accounts where needed. Preview counts and conflicts before confirming. Tasks retain deadlines, recurrence anchors, assignments, archive status, completion timestamps and durations. Screenings become manually sourced movies/screenings; no TMDB matches are invented.

The import is transactional and tracked by source IDs and a checksum. Exact repeated imports return their previous result. Conflicting source IDs do not overwrite existing records: resolve them by removing the already-imported records from the export copy, then preview again. The original browser data stays unchanged. JSON migration and TXT parser-pending uploads are separate workflows.

## Backup and restore

Backups contain account/password hashes, sessions and private imports. Store them outside source control with restricted permissions and copy them to protected storage outside this server.

```sh
npm run db:backup -- /safe/path/reprgb.backup.json
# Restore into a NEW, empty PostgreSQL database after applying migrations:
npm run db:migrate
npm run db:restore -- /safe/path/reprgb.backup.json
```

The command uses a repeatable-read transaction and a checksum-verified logical JSON format. Restore inserts all application tables transactionally, restores IDs and the legacy sequence, and refuses a nonempty database. Apply the **same application schema version** before restoring; the backup does not include Prisma migration metadata or server environment/secrets. Keep `.env`, Frigate CA and Caddy volumes separately backed up.

For Compose, create a host `backups` directory writable by container UID 1000, then run `docker compose exec backend node dist/cli.js backup /backups/reprgb.backup.json`. For restoration, stop application traffic, point the backend at a new migrated database, and run `node dist/cli.js restore /backups/reprgb.backup.json` there. Never wipe the old database just to test a restore.

## Verification

```sh
npm run build
npm test
# Build the sibling frontend first. Requires Chromium and ffmpeg:
npm run test:browser
```

Integration tests launch a disposable real PostgreSQL instance on port 55439, apply migrations, and test API permissions, invitations, task concurrency/idempotency, imports, backup restoration, TMDB isolation and both Frigate authentication modes. Native package install scripts must be allowed for `embedded-postgres`/Prisma/esbuild when your npm version blocks scripts by default. The browser test uses disposable ports 55441–55443, `/usr/bin/chromium` (override `CHROMIUM_PATH`), generated fMP4 media, and the frontend `build/`. It checks two-browser state, task flows, actual MSE decoding, disabled/expanded/logout cleanup and responsive direct routes. No real cameras or personal data are used in tests.

External configuration is still required for actual TMDB searches, the existing Frigate instance and household LAN certificates. Docker daemon access and real devices are needed for deployment verification.

## Persistent local preview without Docker

From this repository run `npm run preview:local` to open the configured preview at **http://localhost:3000**. It starts a loopback-only PostgreSQL instance on port 55438, the API on 3001 and Vite on 3000. Stop it with Ctrl+C; database contents persist in the Git-ignored `.local/postgres` directory.

The first-time setup command is `npm run preview:local -- --setup`. It requires an empty preview database, generates random passwords for `admin@reprgb.test` and `morador@reprgb.test`, registers the resident through an invitation, and adds a small amount of labeled test content. Passwords are stored in `.local/accounts.json` with owner-only permissions. Normal restarts neither reset passwords nor reseed data.

The runner reads the TMDB v3 API key from `../../TMDB/api_key.txt`. The API read token is not required for this integration. Change `tmdbKeyFile` in `.local/preview.json` to use another file. That settings file also holds randomly generated local database/session secrets and is excluded from Git. This preview has no Frigate mappings; use the normal deployment configuration when connecting house cameras. The preview command requires dependencies installed in both repositories and the embedded PostgreSQL native package's install script to have run.

## Notion task definitions

Task definitions support a nullable `weightHours` reference value (hours, including fractions) independently of actual `TaskCompletion.durationMinutes`. A missing weight stays unknown; it is not replaced with zero or written as a completion. Completion snapshots retain the task's reference weight at that time.

Use `{ "kind": "interval", "everyDays": 28, "anchorDate": "2026-09-24" }` for exact day-based recurrence. This preserves distinctions such as 28, 30 and 84 days instead of converting them to calendar months. Fixed anchors, early completion, overdue carryover and no accumulated backlog work the same as existing schedules. Empty source periodicities become `{ "kind": "once" }`.

Admin `POST /api/v1/task-imports/preview` and `/commit` accept:

```json
{
  "source": "notion",
  "startDate": "2026-09-24",
  "rows": [
    {
      "sourceId": "35760149-1f34-8088-9705-f1f19aad872c",
      "name": "Limpar Bancada e Pia",
      "area": "Cozinha",
      "periodDays": 14,
      "weightHours": 1.13
    }
  ]
}
```

Rows use their Notion page IDs. Import only task definitions and reference weights, not the old log, last completion or next-due values. `startDate` explicitly sets the first deadline/interval anchor. Imported tasks are pending and unassigned. Preview reports totals, exceptional tasks, missing weights, duplicates and conflicts. Commit is transactional and serializes concurrent imports; unchanged rows are skipped, while changed previously imported rows return `409` for review. This is a one-time import boundary, not a live Notion synchronization service.

The initial household snapshot is saved in `data/notion-task-catalog.json`: 21 definitions (16 recurring, 5 exceptional), with five unknown weights. It contains only task names, source IDs, periodicities and reference hours; historical logs and old deadlines are omitted. Locations were mapped from task names into the application's location enum and can be corrected by an administrator. The preview import used 2026-09-24 as its first deadline; reimporting the same snapshot does not reset deadlines, ownership or completion history.


Completed tasks can be reopened from **Mostrar concluídas → Voltar para tarefas a fazer**.
The versioned `POST /api/v1/tasks/:id/reopen` returns the latest completed occurrence
to the unassigned list with its original deadline (overdue if that date has passed),
without deleting completion records, durations, or changing recurrence anchors.
Admins can reopen any non-archived completed task; residents can reopen their own
latest completion unless the task has since been assigned to another resident.
Repeated reopening of the same pending occurrence returns 409; reopening is audited.
The to-do pool can be collapsed independently of resident columns; its count and
drop target stay visible. Returning a task to the pool expands it automatically.
