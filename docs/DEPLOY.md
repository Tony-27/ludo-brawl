# Putting Ludo Brawl online

This guide takes you from nothing to `https://your-domain` with automatic HTTPS,
a database with nightly backups, and one-command updates. Budget: about
**€5–10 / month** for a small server plus a domain (~€10 / year).

```
 players ──HTTPS/WSS──▶ Caddy (certificates, :80/:443) ──▶ game server (API + client) ──▶ Postgres
                                                                                └─ nightly backups → deploy/backups
```

> **One server, one game container.** Rooms and live games live in the game
> server's memory, so run exactly one `app` container. That comfortably handles
> many concurrent rooms. Scaling to several servers later needs a shared room
> store (Redis); the code is already structured for that swap.

---

## 1. Things only you can do (accounts and payment)

1. **Rent a server (VPS).** Any provider works; good value options:
   - **Hetzner Cloud**: CX22 (2 vCPU, 4 GB RAM), about €4–5/month.
   - **DigitalOcean**: Basic Droplet with 2 GB RAM, about $12/month.

   Choose **Ubuntu 24.04**, the region closest to your players, and add your
   SSH key while creating it (the provider's dashboard explains how). Note the
   server's **public IPv4 address**.
2. **Buy a domain** (Cloudflare Registrar, Namecheap, Porkbun…), or use a
   subdomain of one you own, e.g. `play.yourname.com`.
3. **Point the domain at the server:** in your domain's DNS settings, add an
   **A record**: name `play` (or `@` for the bare domain) → the server's IP.
   If you use Cloudflare DNS, set the record to **DNS only** (grey cloud) so
   Caddy can get its certificate.

## 2. Prepare the server (once)

SSH in (`ssh root@YOUR_SERVER_IP`) and run:

```sh
# Docker Engine + Compose plugin (official install script)
curl -fsSL https://get.docker.com | sh

# Firewall: SSH + web only
ufw allow OpenSSH && ufw allow 80/tcp && ufw allow 443/tcp && ufw allow 443/udp && ufw --force enable

# Get the deploy files
git clone https://github.com/Tony-27/ludo-brawl.git /opt/ludo-brawl
cd /opt/ludo-brawl/deploy
cp .env.example .env
nano .env    # set DOMAIN and a long POSTGRES_PASSWORD (openssl rand -hex 24)
```

### Let the server pull the image

GitHub Actions publishes the image to `ghcr.io/tony-27/ludo-brawl` on every
merge to `main` (workflow: `.github/workflows/docker.yml`). Packages of a
private repository are private, so either:

- **Make the package public:** on GitHub open your profile, then **Packages**,
  then **ludo-brawl**, then **Package settings**, then **Change visibility** to Public.
  This is the simplest option, and the image contains no secrets.
- **Or log the server in:** create a GitHub *classic* personal access token with
  only the `read:packages` scope, then on the server run
  `echo YOUR_TOKEN | docker login ghcr.io -u Tony-27 --password-stdin`.

## 3. Deploy

```sh
cd /opt/ludo-brawl/deploy
./deploy.sh
```

The script pulls the newest image, starts Caddy, the game, Postgres and the
backup job, waits until the game server reports healthy, and prints the URL.
The first start takes up to a minute while Caddy obtains the HTTPS certificate.

Open `https://your-domain` and share the link: rooms, invites and
reconnects all work over the internet.

## 4. Day-to-day

| Task | Command (in `/opt/ludo-brawl/deploy`) |
|---|---|
| Update to the latest version (after merging to `main`) | `git pull && ./deploy.sh` |
| Roll back to an earlier build | `TAG=sha-abc1234 ./deploy.sh` (tags are listed on the GitHub package page) |
| See what's running | `docker compose -f docker-compose.prod.yml ps` |
| Follow the game server's logs | `docker compose -f docker-compose.prod.yml logs -f app` |
| Restart everything | `docker compose -f docker-compose.prod.yml restart` |
| Stop everything | `docker compose -f docker-compose.prod.yml down` (data stays in volumes) |

Every container restarts by itself after a crash or a server reboot.

> Updating restarts the game server, which ends the games in progress (rooms
> live in memory). Deploy when nobody is mid-match.

## 5. Backups

The `backup` service writes `backups/ludo-YYYYMMDD-HHMMSS.sql.gz` once a day
and keeps `BACKUP_KEEP_DAYS` days (default 14). Copy them off the server now
and then, e.g. from your PC: `scp root@YOUR_SERVER_IP:/opt/ludo-brawl/deploy/backups/*.gz .`

Restore a backup:

```sh
cd /opt/ludo-brawl/deploy
docker compose -f docker-compose.prod.yml stop app
gunzip -c backups/ludo-20260101-030000.sql.gz | \
  docker compose -f docker-compose.prod.yml exec -T db psql -U ludo -d ludo
docker compose -f docker-compose.prod.yml start app
```

## 6. Try the production stack on your PC first (optional)

With Docker Desktop running, from the repository root:

```sh
docker build -t ludo-brawl:local .
cd deploy
printf 'DOMAIN=localhost\nPOSTGRES_PASSWORD=localtest\nIMAGE=ludo-brawl\nTAG=local\n' > .env
docker compose -f docker-compose.prod.yml up -d
```

Then open <https://localhost> (your browser will warn about Caddy's local
certificate; that's expected for `localhost` only). Clean up with
`docker compose -f docker-compose.prod.yml down -v` and delete that `.env`.

## Troubleshooting

- **The site doesn't load or the certificate fails:** check that the A record points at the
  server (`ping your-domain`), that ports 80 and 443 are open, and run
  `docker compose -f docker-compose.prod.yml logs caddy`.
- **`deploy.sh` says the app is not healthy:** it prints the app logs. A
  wrong `POSTGRES_PASSWORD` after the database was first created is the usual
  cause. The password is fixed when the `pgdata` volume is created.
- **`pull access denied`:** make the package public or `docker login ghcr.io`
  (step 2).
