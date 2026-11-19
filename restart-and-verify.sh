#!/bin/bash
# 生产重启 + 自动验收（脱离 DSH 会话执行，避免 systemctl restart 自杀）。
# 用法：systemd-run --on-active=10s --unit=dsh-ziwei-verify /root/workspace/plugins/dsh-ziwei/restart-and-verify.sh
set -u
# systemd 单元里 HOME 是空的，fontconfig 会跳过 /root/.fonts → 截图里中文成豆腐块
export HOME=/root
export XDG_CACHE_HOME=/root/.cache

PLUGIN_DIR=/root/workspace/plugins/dsh-ziwei
OUT_DIR="$PLUGIN_DIR/verification/prod"
LOG="$OUT_DIR/restart-$(date +%Y%m%d-%H%M%S).log"
NODE=/root/.nvm/versions/node/v24.21.0/bin/node

mkdir -p "$OUT_DIR"
exec > >(tee -a "$LOG") 2>&1
echo "[$(date '+%F %T')] 开始：重启 deepseek-harness 并验收 dsh-ziwei"

systemctl restart deepseek-harness.service || { echo "重启失败"; exit 1; }

# 等端口就绪
for i in $(seq 1 60); do
  sleep 2
  if curl -sf -o /dev/null "http://127.0.0.1:3080/" ; then break; fi
  if ss -ltn 2>/dev/null | grep -q ':3080 '; then break; fi
done
sleep 3

URL=$(journalctl -u deepseek-harness.service --since '-2 min' 2>/dev/null \
  | grep -o 'http://127.0.0.1:3080/?token=[A-Za-z0-9_-]*' | tail -1)
if [ -z "$URL" ]; then
  URL=$(journalctl -u deepseek-harness.service 2>/dev/null \
    | grep -o 'http://127.0.0.1:3080/?token=[A-Za-z0-9_-]*' | tail -1)
fi
if [ -z "$URL" ]; then
  echo "[$(date '+%F %T')] 没拿到带 token 的地址，跳过浏览器验收"
  exit 2
fi
echo "[$(date '+%F %T')] 实例已起：${URL%%\?*}"

# 公网入口健康检查：/ziwei/ 经 Caddy → dsh-passwords(3081) → DSH(3080) → 插件。
# 未登录时应当是登录跳转/401，绝不能是 404（404 = 网关或插件没把路径交给 DSH）。
EDGE=$(curl -sk -o /dev/null -w '%{http_code}' --resolve dsh.frankfurtlin.top:443:127.0.0.1 \
  https://dsh.frankfurtlin.top/ziwei/ 2>/dev/null)
echo "[$(date '+%F %T')] 公网 dsh.frankfurtlin.top/ziwei/ 未登录状态码：$EDGE（期望 302/401，404 表示未接通）"

cd "$PLUGIN_DIR" || exit 1
# Playwright 期望的浏览器 revision 可能已被别的工具升级掉：本机有任意 headless shell 就兜底
if [ -z "${DSH_ZIWEI_CHROMIUM:-}" ]; then
  CANDIDATE=$(ls -d "$HOME"/.cache/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell 2>/dev/null | sort -V | tail -1)
  [ -n "$CANDIDATE" ] && [ -x "$CANDIDATE" ] && export DSH_ZIWEI_CHROMIUM="$CANDIDATE"
fi
"$NODE" verify.mjs --url "$URL" --out "$OUT_DIR" --ask
STATUS=$?

# 生辰记忆（服务端配置文件）回归：写入 `~/.dsh/ziwei/birth.json`
TOKEN=$(printf '%s' "$URL" | sed -n 's/.*[?&]token=\([A-Za-z0-9_-]*\).*/\1/p')
if [ -n "$TOKEN" ]; then
  APP_URL="$(printf '%s' "${URL%%\?*}" | sed 's:/*$::')/ziwei/chart"
  "$NODE" "$PLUGIN_DIR/app/test-persistence.mjs" \
    --url "$APP_URL" --token "$TOKEN" --shots "$OUT_DIR/persistence"
  PERSIST=$?
  echo "[$(date '+%F %T')] 生辰记忆回归 exit=$PERSIST"
  [ "$PERSIST" -ne 0 ] && STATUS=1
else
  echo "[$(date '+%F %T')] 没取到 token，跳过生辰记忆回归"
fi

echo "[$(date '+%F %T')] 验收结束，exit=$STATUS，报告：$OUT_DIR/report.json"
exit $STATUS
