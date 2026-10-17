#!/usr/bin/env bash
set -eu
set -o pipefail 2>/dev/null || true

# Read-only production checklist. Values of secrets are never printed.
BASE="${BASE:-/srv/chinese-study}"
APP="${APP:-$BASE/current}"
ENV_FILE="${ENV_FILE:-/etc/chinese-study/backend.env}"
PYTHON="${PYTHON:-$BASE/venv/bin/python}"

echo '== VERSION =='
printf 'current_path='
readlink -f "$APP" || true
if [ -f "$APP/backend/manage.py" ]; then
  git -C "$APP" rev-parse --short HEAD 2>/dev/null || echo 'not-a-git-checkout'
else
  echo 'manage.py=MISSING'
  exit 2
fi

echo '== SERVICES =='
systemctl is-active chinese-study || true
nginx -t
ss -ltnp | grep -E ':(22|80|443|8000)([[:space:]]|$)' || true

echo '== DNS =='
getent ahostsv4 zsbzy.com || true
getent ahostsv4 www.zsbzy.com || true

echo '== ENVIRONMENT KEYS (SET/MISSING ONLY) =='
if [ ! -f "$ENV_FILE" ]; then
  echo 'environment_file=MISSING'
  exit 2
fi
while IFS= read -r key; do
  [ -n "$key" ] || continue
  if grep -Eq "^${key}=[^[:space:]]" "$ENV_FILE"; then
    echo "$key=SET"
  else
    echo "$key=MISSING_OR_EMPTY"
  fi
done <<'REQUIRED_KEYS'
DJANGO_SECRET_KEY
STUDENT_SESSION_ENCRYPTION_KEYS
WECHAT_APP_ID
WECHAT_APP_SECRET
VIRTUAL_PAYMENT_OFFER_ID
VIRTUAL_PAYMENT_APP_KEY
VIRTUAL_PAYMENT_SANDBOX_APP_KEY
VIRTUAL_PAYMENT_CALLBACK_TOKEN
VIRTUAL_PAYMENT_CALLBACK_AES_KEY
REQUIRED_KEYS
grep -E '^(DJANGO_DEBUG|DB_ENGINE|VIRTUAL_PAYMENT_ENABLED|VIRTUAL_PAYMENT_ANDROID_ENABLED|VIRTUAL_PAYMENT_IOS_ENABLED|VIRTUAL_PAYMENT_ENV)=' "$ENV_FILE" || true

echo '== HTTP =='
curl --fail --silent --show-error --max-time 15 https://zsbzy.com/healthz
echo
curl --fail --silent --show-error --max-time 15 -H 'Host: zsbzy.com' http://127.0.0.1:8000/readyz
echo

echo '== PUBLIC API SMOKE =='
cd "$APP"
set -a
. "$ENV_FILE"
set +a
export DJANGO_SETTINGS_MODULE=config.production_settings
set +e
"$PYTHON" backend/scripts/check_public_api.py --base-url https://zsbzy.com
smoke_status=$?
set -e
echo "public_api_smoke_exit=$smoke_status"

echo '== DATABASE COUNTS (READ ONLY) =='
"$PYTHON" backend/manage.py shell -c '
from content.models import Article, Category
from content.access import published_questions
from django.db import connection
from entitlements.models import Product
from resources.models import GroupResourceConfiguration
from writing.access import published_writings
print("products=", list(Product.objects.values("id", "price_fen", "is_active", "platform_product_id", "platform_sync_state")))
print("active_categories=", Category.objects.filter(is_active=True).count())
print("active_articles=", Article.objects.filter(is_active=True).count())
print("published_questions=", published_questions().count())
print("published_writings=", published_writings().count())
print("database_vendor=", connection.vendor)
if connection.vendor == "postgresql":
    with connection.cursor() as cursor:
        cursor.execute("SHOW server_version")
        print("database_server_version=", cursor.fetchone()[0])
configuration = GroupResourceConfiguration.current()
print("resources_enabled=", bool(configuration and configuration.is_enabled), "qr_configured=", bool(configuration and configuration.group_qr_code), "claim_code_configured=", bool(configuration and configuration.claim_code))
'
exit "$smoke_status"
