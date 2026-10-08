# Deployment Guide (VPS)

Production endpoint: `https://mcp.techmavie.digital/datagovsg/mcp`

## Architecture

```
MCP client ──HTTPS──> nginx (/datagovsg/) ──> 127.0.0.1:8098 ──> container mcp-datagovsg:8080
                                                                   │
                                                                   ├── data.gov.sg / SingStat APIs (x-api-key: DATAGOVSG_API_KEY)
                                                                   └── mcp-key-service:8090 (only for usr_ keys, via Docker network mcp-network)
```

| Item | Value |
|------|-------|
| VPS path | `/opt/mcp-servers/datagovsg` |
| Container | `mcp-datagovsg` |
| Host port | `127.0.0.1:8098` (localhost only) |
| Docker network | `mcp-network` (external, shared with mcp-key-service) |
| Data volume | `datagovsg-data` → `/app/data` (analytics backup, catalogue index) |
| Firebase path | `/mcp-analytics/mcp-datagovsg` |

## First-time setup

### 1. Get a data.gov.sg API key

1. Log in at https://data.gov.sg (top right).
2. Go to **API Keys** → **Create API Key** → choose **Production** and describe the use (public MCP server).
3. Copy the key (shown once). Keys expire; data.gov.sg emails reminders 3 months before.

### 2. Check the port is free

```bash
ss -ltnp | grep 8098 || echo "8098 is free"
```

If it is taken, change `127.0.0.1:8098` in `docker-compose.yml`, `deploy/nginx-mcp.conf` and the health check URL in `.github/workflows/deploy-vps.yml`.

### 3. Clone and configure

```bash
cd /opt/mcp-servers
git clone https://github.com/hithereiamaliff/mcp-datagovsg.git datagovsg
cd datagovsg
cp .env.example .env
nano .env
```

Fill in:

| Variable | Value |
|----------|-------|
| `DATAGOVSG_API_KEY` | Key from step 1 |
| `DATAGOVSG_API_KEY_TIER` | `production` |
| `KEY_SERVICE_URL` | `http://mcp-key-service:8090/internal/resolve` |
| `KEY_SERVICE_TOKEN` | Token from step 4 |
| `ANALYTICS_RESET_KEY` | `openssl rand -hex 16` |
| `ANALYTICS_SALT` | `openssl rand -hex 16` |
| `FIREBASE_DATABASE_URL` | Same value as `/opt/mcp-servers/datagovmy/.env` |

```bash
chmod 600 .env
```

### 4. Register the server with mcp-key-service

```bash
TOKEN=$(openssl rand -hex 32); echo "$TOKEN"
nano /opt/mcp-key-service/.env
# Append to INTERNAL_SERVER_TOKENS:   ,datagovsg:<TOKEN>
cd /opt/mcp-key-service && docker compose up -d
```

Put the same `<TOKEN>` in `/opt/mcp-servers/datagovsg/.env` as `KEY_SERVICE_TOKEN`.

The `datagovsg` connector itself ships with mcp-key-service (`src/connectors.ts`), so users can register an optional data.gov.sg key at https://mcpkeys.techmavie.digital once that change is deployed.

### 5. Firebase credentials (optional)

```bash
mkdir -p .credentials
cp ../.credentials/firebase-service-account.json .credentials/
chown -R 1001:1001 .credentials   # container runs as uid 1001
```

### 6. Start

```bash
docker network inspect mcp-network >/dev/null 2>&1 || docker network create mcp-network
docker compose up -d --build
curl -s http://127.0.0.1:8098/health
```

The first start crawls the data.gov.sg catalogue (~20 seconds) for dataset search; it is saved to the volume, so later restarts are instant.

### 7. nginx

Add the block from `deploy/nginx-mcp.conf` to the `mcp.techmavie.digital` server block:

```bash
sudo nano /etc/nginx/sites-available/mcp.techmavie.digital
sudo nginx -t && sudo systemctl reload nginx
curl -s https://mcp.techmavie.digital/datagovsg/health
```

### 8. GitHub Actions secrets

In the GitHub repo → Settings → Secrets and variables → Actions, add the same values used by mcp-datagovmy:

- `VPS_HOST`
- `VPS_USERNAME`
- `VPS_SSH_KEY`
- `VPS_PORT`

After that, every push to `main` runs typecheck/lint/build and then deploys.

## Verify

```bash
# From anywhere
MCP_URL=https://mcp.techmavie.digital/datagovsg/mcp npm run smoke

# Key-service path (with a registered usr_ key)
MCP_URL="https://mcp.techmavie.digital/datagovsg/mcp?api_key=usr_..." npm run smoke
```

`GET /health` shows `serverApiKey`, `keyServiceEnabled`, `firebaseEnabled` and the catalogue index status.

## Operations

```bash
cd /opt/mcp-servers/datagovsg
docker compose logs -f              # logs
docker compose restart              # restart
docker compose up -d --build        # rebuild after manual changes
docker volume inspect datagovsg_datagovsg-data
```

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `serverApiKey: "not configured"` | Set `DATAGOVSG_API_KEY` in `.env`, then `docker compose up -d` |
| Tool errors mention rate limits | Check the API key is set and not expired (data.gov.sg silently treats invalid keys as anonymous) |
| `keyServiceEnabled: false` | Set both `KEY_SERVICE_URL` and `KEY_SERVICE_TOKEN` |
| `usr_` keys always fall back to the server key | Check `docker network inspect mcp-network` lists both containers, and that the token matches `INTERNAL_SERVER_TOKENS` (logs show `[key-service] ...`) |
| `firebaseEnabled: false` | Check `FIREBASE_DATABASE_URL` and that `.credentials/firebase-service-account.json` is readable by uid 1001 |
| Deploy fails at `git pull --ff-only` | Someone edited files on the VPS; inspect with `git status` and reset or commit them |
| nginx 404 on `/datagovsg/` | The location block is missing or nginx was not reloaded |
