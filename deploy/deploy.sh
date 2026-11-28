#!/usr/bin/env sh
# One-command deploy / update, run on the server from this folder:
#
#   ./deploy.sh            # pull the latest image and (re)start everything
#   TAG=sha-abc1234 ./deploy.sh   # run a specific build (rollback)
#
set -eu
cd "$(dirname "$0")"

if [ ! -f .env ]; then
  echo "No .env here. Run: cp .env.example .env  and fill it in." >&2
  exit 1
fi
if grep -q '^POSTGRES_PASSWORD=change-me' .env; then
  echo "Set a real POSTGRES_PASSWORD in .env first (e.g. openssl rand -hex 24)." >&2
  exit 1
fi

mkdir -p backups
COMPOSE="docker compose -f docker-compose.prod.yml"

echo "==> Pulling images"
$COMPOSE pull

echo "==> Starting"
$COMPOSE up -d --remove-orphans

echo "==> Waiting for the game server to be healthy"
i=0
until [ "$($COMPOSE ps app --format '{{.Health}}' 2>/dev/null)" = "healthy" ]; do
  i=$((i + 1))
  if [ "$i" -gt 60 ]; then
    echo "The app did not become healthy. Recent logs:" >&2
    $COMPOSE logs --tail 80 app >&2
    exit 1
  fi
  sleep 2
done

docker image prune -f >/dev/null
$COMPOSE ps
. ./.env
echo "==> Live at https://${DOMAIN}"
