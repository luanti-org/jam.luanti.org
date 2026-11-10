# Luanti Game Jam

A lightweight, anonymous, moderated game jam gallery for [Luanti](https://www.luanti.org/). Participants submit public Git repositories; administrators review and approve individual commits.

[Website](https://jam.luanti.org) · [Participation rules](content/rules.md) · [Client SDK](client/sdk.ts)

## Development

**Requirements:** Bun >=1.4.4, Linux, Git >=2.37, Bubblewrap (with `--size` support), util-linux `prlimit`, and working user/PID namespaces.

```sh
bun ci
cp .env.example .env
bun run dev
```

Serves the frontend and API at `http://127.0.0.1:3000`.

### Commands

```sh
bun run format        # Format
bun run check         # Lint and typecheck
bun test              # Unit and integration tests
bun run test:release  # Full suite, sandbox required
bun run test:https    # Live Git-host checks (optional)
bun run build         # Build static frontend to dist/
```

Run `test:release` on the target Linux environment before deployment. Production builds require `PUBLIC_API_URL`.

## Configuration

Copy `.env.example` to `.env`. The main production settings are:

| Variable | Description |
|---|---|
| `PUBLIC_API_URL` | Public HTTPS API origin; embedded in frontend builds |
| `CLIENT_ORIGIN` | Allowed frontend origin, e.g. `https://jam.luanti.org` |
| `DATA_DIR` | Private persistent backend storage (default `./data`) |
| `API_HOST`, `API_PORT` | Listener address and port |
| `TRUST_LOCAL_PROXY` | Enable only behind a trusted loopback proxy that overwrites `X-Real-IP` |

See `.env.example` for defaults.

Site content and configuration are in [`content/`](content/): event settings, Git host policies, quotas, UI text, dialogue, and Markdown prose. Frontend changes require rebuilding; most backend configuration changes require restarting the API.

Panel Markdown places widgets with standalone paragraphs: `{{!submission}}` in `cauldron.md`, and `{{!themes}}` / `{{!resources}}` in `pantry.md`. Each widget may appear once in its document. The text guide renders pantry widgets as static resource lists.

## Deployment

### Frontend

GitHub Pages serves [jam.luanti.org](https://jam.luanti.org) from the static `dist/` build.

The [Pages workflow](.github/workflows/pages.yml) builds and deploys automatically from `master`, or on manual dispatch.

1. Select **GitHub Actions** as the Pages deployment source.
2. Set the custom domain to `jam.luanti.org`.
3. Configure the repository Actions variable `PUBLIC_API_URL`.

### Backend

Run on Linux as an unprivileged service user, with private persistent storage and an HTTPS reverse proxy.

For an existing schema v1 database, stop the API, back up the database, and run the one-time conversion before starting the updated API:

```sh
sqlite3 -bail /path/to/data/jam.sqlite < scripts/migrate-v1-to-v2.sql
```

The SQL transaction preserves submissions, screenshots, and review state. The application checks the schema version and does not convert databases automatically. Databases already on schema v2 need no conversion.

```sh
bun ci
bun start
```

Use a single API process, bind to loopback, and allow at least 630 seconds for submission requests through the proxy. Verify startup with `GET /api/health`.

### Administration

Open `/admin.html` to generate an administrator identity. Save the recovery phrase privately and add the displayed public key to `DATA_DIR/admins.json`, an array of authorized public keys.

Removing a key revokes access.

## Operations

- **Storage:** SQLite in `DATA_DIR`; back up using SQLite's online backup facility or stop the API before copying database files. Back up `admins.json` separately.
- **Logs:** `DATA_DIR/incidents.log` and service stderr.
- **Limits:** Configured in `content/limits.json`. Inspections use one active worker and four waiting slots; resource violations can trigger hourly penalties.
- **Recovery:** Preserve backups before upgrades and test restores. Rejected or removed entries may retain moderation records; source repositories are not mirrored.

Keep `DATA_DIR` and `.env` private. The backend requires a working Bubblewrap sandbox and refuses to start without its required security capabilities.
