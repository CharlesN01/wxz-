# 服务器 Agent 发布与生产数据执行指令

目标服务器：`152.136.62.224`
服务目录：`/srv/chinese-study`
运行服务：`chinese-study.service`
公网域名：`https://zsbzy.com`

本指令使用已生成的 `wxz.tar.gz` 发布包。包外 SHA-256 文件必须一起上传；任何校验失败都停止，不覆盖当前 release。命令不会打印环境密钥，也不执行支付开关开启。

## 一、开发机准备和上传

开发机当前文件：

```text
C:\Users\24429\.codex\worktrees\backend-phase-05\wx专升本语文学习小程序\wxz.tar.gz
C:\Users\24429\.codex\worktrees\backend-phase-05\wx专升本语文学习小程序\wxz.tar.gz.sha256
```

本次交付包的 Git 提交和大小由上传前交付消息提供；SHA-256 以同目录 `wxz.tar.gz.sha256` 为准。上传前先在开发机核对旁置 SHA 文件。

上传时使用服务器 Agent 已经配置好的 SSH 私钥；聊天中提供的公钥不能代替客户端私钥。以下命令中的 `SERVER_KEY` 只在服务器 Agent 自己的终端替换，不要把私钥内容写进项目：

```powershell
$pkg = 'C:\Users\24429\.codex\worktrees\backend-phase-05\wx专升本语文学习小程序\wxz.tar.gz'
$sum = 'C:\Users\24429\.codex\worktrees\backend-phase-05\wx专升本语文学习小程序\wxz.tar.gz.sha256'
$key = 'SERVER_KEY'
scp -i $key $pkg $sum root@152.136.62.224:/tmp/
```

## 二、服务器只读核查

先确认服务和数据库状态，不改配置、不重启：

```bash
set -Eeuo pipefail
curl --fail --silent --show-error \
  https://raw.githubusercontent.com/INHaiLing/wxz-/codex/restore-prototype-16/backend/deploy/check_server_state.sh \
  -o /tmp/check_server_state.sh
bash /tmp/check_server_state.sh
```

输出只应包含版本、监听、DNS、环境键 `SET/MISSING`、开关、健康接口、公开 smoke、数据库类型/版本和脱敏数量。若失败原因为服务/配置异常，先修复并复核；若只因生产内容为空，则先完成下节备份，再按第六节导入正式数据。任何情况下都不能用 `seed_demo` 填充生产。

## 三、备份生产 PostgreSQL

备份先于任何迁移、商品初始化或题库导入。备份目录只允许 root/服务账号访问，文件名不要上传 Git 或 Web 目录：

```bash
set -Eeuo pipefail
BASE=/srv/chinese-study
ENV=/etc/chinese-study/backend.env
BACKUP_DIR=/var/lib/chinese-study/backups
STAMP=$(date +%Y%m%d%H%M%S)
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
set -a
. "$ENV"
set +a
umask 077
export PGPASSWORD="$DB_PASSWORD"
pg_dump --format=custom --file="$BACKUP_DIR/chinese-study-$STAMP.dump" \
  --host="${DB_HOST:-127.0.0.1}" --port="${DB_PORT:-5432}" \
  --username="$DB_USER" "$DB_NAME"
unset PGPASSWORD
test -s "$BACKUP_DIR/chinese-study-$STAMP.dump"
sha256sum "$BACKUP_DIR/chinese-study-$STAMP.dump"
```

## 四、部署新 release

只有 `/tmp/wxz.tar.gz` 的 SHA 与包外文件一致时才继续。`current` 是软链接时保留旧目标，不在旧目录执行 `git pull`：

```bash
set -Eeuo pipefail
BASE=/srv/chinese-study
STAMP=$(date +%Y%m%d%H%M%S)
RELEASE="$BASE/releases/wxz-$STAMP"
mkdir -p "$RELEASE"
printf '%s\n' "$RELEASE" > /tmp/wxz-release-path
chmod 600 /tmp/wxz-release-path
cd /tmp
sha256sum -c wxz.tar.gz.sha256
tar -xzf wxz.tar.gz -C "$RELEASE"
test -f "$RELEASE/backend/manage.py"
chown -R root:chinese-study "$RELEASE"
chmod -R u=rwX,g=rX,o= "$RELEASE"
```

先在 release 目录执行生产检查和迁移计划。后续命令从权限为 600 的临时文件读取本次 release 路径，避免误选其他 release。

```bash
BASE=/srv/chinese-study
RELEASE=$(< /tmp/wxz-release-path)
case "$RELEASE" in "$BASE"/releases/wxz-*) ;; *) echo 'invalid release path'; exit 2 ;; esac
test -f "$RELEASE/backend/manage.py"
cd "$RELEASE/backend"
set -a
. /etc/chinese-study/backend.env
set +a
export DJANGO_SETTINGS_MODULE=config.production_settings
/srv/chinese-study/venv/bin/python manage.py check --deploy --fail-level WARNING
/srv/chinese-study/venv/bin/python manage.py migrate --plan
```

确认迁移计划无异常后，再执行迁移、静态文件和角色初始化。继续使用同一 `RELEASE` 目录：

```bash
BASE=/srv/chinese-study
RELEASE=$(< /tmp/wxz-release-path)
case "$RELEASE" in "$BASE"/releases/wxz-*) ;; *) echo 'invalid release path'; exit 2 ;; esac
test -f "$RELEASE/backend/manage.py"
cd "$RELEASE/backend"
set -a
. /etc/chinese-study/backend.env
set +a
export DJANGO_SETTINGS_MODULE=config.production_settings
/srv/chinese-study/venv/bin/python manage.py migrate
/srv/chinese-study/venv/bin/python manage.py collectstatic --noinput
/srv/chinese-study/venv/bin/python manage.py setup_roles
/srv/chinese-study/venv/bin/python manage.py setup_business_roles
/srv/chinese-study/venv/bin/python manage.py seed_product
```

`seed_product` 只创建缺少的 `all-chinese` 商品；随后必须在 Django 后台确认：金额 10 分、启用、平台商品编号 `VIP`、平台同步状态为已同步。该命令不导入题库，不设置支付开关。

## 五、切换和回退

先在新 release 上运行公开检查；生产内容为空时检查会返回非零，不能切换为“已验收”版本：

```bash
BASE=/srv/chinese-study
RELEASE=$(< /tmp/wxz-release-path)
case "$RELEASE" in "$BASE"/releases/wxz-*) ;; *) echo 'invalid release path'; exit 2 ;; esac
test -f "$RELEASE/backend/manage.py"
cd "$RELEASE"
set -a
. /etc/chinese-study/backend.env
set +a
export DJANGO_SETTINGS_MODULE=config.production_settings
/srv/chinese-study/venv/bin/python backend/scripts/check_public_api.py --base-url https://zsbzy.com
```

只有迁移、健康检查、商品/题库数据和服务状态均符合计划时才切换：

```bash
BASE=/srv/chinese-study
RELEASE=$(< /tmp/wxz-release-path)
case "$RELEASE" in "$BASE"/releases/wxz-*) ;; *) echo 'invalid release path'; exit 2 ;; esac
test -f "$RELEASE/backend/manage.py"
OLD_RELEASE=$(readlink -f "$BASE/current")
test -d "$OLD_RELEASE"
ln -sfn "$RELEASE" "$BASE/current.next"
mv -Tf "$BASE/current.next" "$BASE/current"
systemctl restart chinese-study
if ! systemctl is-active --quiet chinese-study || ! curl --fail --silent --show-error https://zsbzy.com/healthz; then
  ln -sfn "$OLD_RELEASE" "$BASE/current.rollback"
  mv -Tf "$BASE/current.rollback" "$BASE/current"
  systemctl restart chinese-study
  systemctl is-active --quiet chinese-study
  curl --fail --silent --show-error https://zsbzy.com/healthz
  exit 1
fi
```

如果新 release 启动失败，立即切回切换前保存的旧软链接目标，重启并验证 `/healthz`。不要删除旧 release，直到生产登录和业务 smoke 完成。

## 六、正式题库和业务数据

1. 先备份数据库，再在 Django 后台预检正式 XLSX。
2. 确认导入后人工审核草稿，逐批发布分类、文言篇目和题目。
3. 导入并发布至少一个应用文分类和详情。
4. 资料群只有拿到正式二维码、微信号和口令后才启用；缺素材保持空态。
5. 禁止在生产运行 `seed_demo` 或复制本机 QA 数据库。
6. 重跑 `check_public_api.py`，直到分类、篇目、文学题、文言题、应用文和 `all-chinese` 商品均非空；资料群关闭只能作为明确登记的非阻塞警告。

## 七、回调和支付边界

兼容模式回调 GET 必须使用微信后台当前 Token 计算签名并回显 `echostr`。本机 Token 对公网返回过 400，服务器 Agent 必须用 `/etc/chinese-study/backend.env` 的 Token 重新验证；不要把 Token 放入命令历史或报告。

在 Android 沙箱的创建订单、支付、平台通知、查单、发权和退款/对账全部通过前，保持：

```text
VIRTUAL_PAYMENT_ENABLED=false
VIRTUAL_PAYMENT_ANDROID_ENABLED=false
VIRTUAL_PAYMENT_IOS_ENABLED=false
```

不得用客户端支付成功回调直接发放权益。支付开关、正式支付和 iOS 价格调整不属于本次服务器数据准备步骤。
