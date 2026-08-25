#!/bin/bash
set -euo pipefail
export HOME=/root
export PATH=/www/server/nodejs/v22.22.1/bin:/bin:/sbin:/usr/bin:/usr/sbin:/usr/local/bin:/usr/local/sbin:$PATH
SITE=/www/wwwroot/life.blinddev.xyz
LOG=/tmp/kopilka-life-deploy.log
# Идемпотентность: если деплой уже успешно прошёл, повторные запуски не трогаем PM2.
MARKER=/tmp/kopilka-life-deployed.ok
if [ -f "$MARKER" ] && [ -d "$SITE/.git" ]; then
  echo "=== DEPLOY already done, skip ===" > "$LOG" 2>&1
  exit 0
fi
{
echo "=== DEPLOY BEGIN $(date) ==="
cd "$SITE"

# Сохраняем нужные aaPanel/runtime-файлы, остальное уберём (для чистого git-клона)
mkdir -p /root/kopilka-panel-preserve
for f in .well-known .htaccess .user.ini .env data; do
  [ -e "$SITE/$f" ] && cp -a "$SITE/$f" /root/kopilka-panel-preserve/ 2>/dev/null || true
done

# Очищаем default-файлы aaPanel (кроме preserved)
find "$SITE" -mindepth 1 -maxdepth 1 ! -name '.well-known' ! -name '.htaccess' ! -name '.user.ini' ! -name '.env' ! -name 'data' -exec rm -rf {} + 2>/dev/null || true
cp -a /root/kopilka-panel-preserve/.well-known "$SITE/" 2>/dev/null || true
[ -e /root/kopilka-panel-preserve/.htaccess ] && cp -a /root/kopilka-panel-preserve/.htaccess "$SITE/" || true
[ -e /root/kopilka-panel-preserve/.user.ini ] && cp -a /root/kopilka-panel-preserve/.user.ini "$SITE/" || true
[ -e /root/kopilka-panel-preserve/.env ] && cp -a /root/kopilka-panel-preserve/.env "$SITE/" || true
[ -d /root/kopilka-panel-preserve/data ] && cp -a /root/kopilka-panel-preserve/data "$SITE/" || true

# Клонируем репозиторий (в непустую папку сайта: git init + remote вместо git clone)
if [ ! -d "$SITE/.git" ]; then
  git config --global --add safe.directory "$SITE" || true
  cd "$SITE"
  git init -b main 2>&1 || true
  git remote remove origin 2>/dev/null || true
  git remote add origin https://github.com/web3blind/kopilka-life.git 2>&1
else
  cd "$SITE"
  git config --global --add safe.directory "$SITE" || true
fi
git fetch origin main 2>&1
git checkout -f -B main origin/main 2>&1 || git reset --hard origin/main 2>&1

# Убедимся, что runtime-файлы не перезаписаны
mkdir -p "$SITE/data"
touch "$SITE/data/.gitkeep"

# Устанавливаем зависимости
npm ci --no-audit 2>&1 || npm install --no-audit 2>&1

# Прод .env (без BOT_TOKEN — добавим позже). Никогда не коммитится.
# SESSION_SECRET генерируется случайно при первом деплое, если .env ещё нет.
if [ ! -f "$SITE/.env" ]; then
  SECRET="$(openssl rand -hex 24 2>/dev/null || head -c 48 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  cat > "$SITE/.env" <<EOF
NODE_ENV=production
PORT=3010
APP_BASE_URL=https://life.blinddev.xyz
WEBAPP_URL=https://life.blinddev.xyz
BOT_TOKEN=
DB_PATH=$SITE/data/kopilka-life.sqlite
SESSION_SECRET=$SECRET
DEV_AUTH_ENABLED=false
SCHEDULER_ENABLED=true
TELEGRAM_AUTH_MAX_AGE_SECONDS=86400
RATE_LIMIT_API_MAX=120
RATE_LIMIT_AUTH_MAX=20
RATE_LIMIT_DEV_MAX=20
RATE_LIMIT_WEBHOOK_MAX=120
EOF
fi

# Инициализируем БД
node "$SITE/scripts/init-db.js" 2>&1 || true

# Запускаем PM2
pm2 delete kopilka-life >/dev/null 2>&1 || true
cd "$SITE"
PORT=3010 pm2 start npm --name kopilka-life -- start 2>&1
pm2 save 2>&1

echo "DEPLOY_OK"
touch "$MARKER"
curl -sS -o /dev/null -w "local_health_http=%{http_code}\n" http://127.0.0.1:3010/health 2>&1 || echo "local_health=fail"
} > "$LOG" 2>&1
