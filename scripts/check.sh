#!/usr/bin/env bash
#
# dsh-ziwei 一键自检：改完代码跑这一个就够了。
#
#   scripts/check.sh            # 全套：静态检查 → 重建应用 → 起一个隔离的 DSH 实例跑端到端验收
#   scripts/check.sh --static   # 只跑静态检查（快，pre-commit 钩子用的就是它）
#   scripts/check.sh --no-build # 跳过 next build / 重启应用（只改了插件代码时用）
#
# 它做的事：
#   1. 静态：node --check（host 半 + client 半 + 验收脚本）、app 的 tsc --noEmit、app 的内核回归测试；
#   2. 构建：app/npm run build，然后重启 dsh-ziwei-app.service（插件反代的就是它）；
#   3. 端到端：在 /tmp/dsh-ziwei-check 里起一个**隔离的** DSH 实例（独立 DSH_HOME、独立端口 3099（被占用时自动顺延）、
#      独立会话与 cookie），用真实浏览器跑 verify.mjs（47 项）与 app/test-persistence.mjs（29 项），
#      跑完把实例关掉。生产实例（3080）与你的真实生辰配置全程不被碰。
#
# 依赖（本机已有）：
#   - playwright：`~/workspace/hermes-site/tools/node_modules`（两个验收脚本按家目录推导，可用
#     DSH_ZIWEI_PLAYWRIGHT_MODULES 覆盖）
#   - 中文字体：`~/.fonts` 下至少有 Noto Sans SC，否则截图里的中文是豆腐块
#   - 真实 DSH_HOME 里的 .credentials.yaml（模型调用）与 storages/workspace.json（新会话要选工作区）
#
set -uo pipefail

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
APP="$ROOT/app"
REAL_HOME="${DSH_HOME:-$HOME/.dsh}"
CHECK_HOME="${CHECK_HOME:-/tmp/dsh-ziwei-check}"
PROFILE="${CHECK_PROFILE:-check}"
PORT="${CHECK_PORT:-3099}"
# 本机可能同时有别的 agent/实例占着 3099（遇到过）：自动顺延，避免验收实例起不来
if [[ -z "${CHECK_PORT:-}" ]]; then
  for candidate in 3099 3100 3101 3102 3103; do
    if ! ss -ltn 2>/dev/null | grep -q ":$candidate "; then PORT="$candidate"; break; fi
  done
fi
OUT="${CHECK_OUT:-$ROOT/verification/check}"
DSH_BIN="${DSH_BIN:-$(command -v dsh || true)}"

STATIC_ONLY=0
SKIP_BUILD=0
for arg in "$@"; do
  case "$arg" in
    --static) STATIC_ONLY=1 ;;
    --no-build) SKIP_BUILD=1 ;;
    -h|--help) sed -n '2,28p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "未知参数：$arg（试试 --static / --no-build / --help）" >&2; exit 2 ;;
  esac
done

PASS=0
FAIL=0
SKIPPED=0
declare -a FAILED_NAMES=()

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok() { PASS=$((PASS + 1)); printf '  \033[32mPASS\033[0m  %s\n' "$*"; }
bad() { FAIL=$((FAIL + 1)); FAILED_NAMES+=("$1"); printf '  \033[31mFAIL\033[0m  %s\n' "$*"; }
skip() { SKIPPED=$((SKIPPED + 1)); printf '  \033[33mSKIP\033[0m  %s\n' "$*"; }

# run <名字> <命令...>：跑一条命令，按退出码记 PASS/FAIL，输出落到 $OUT/logs/<名字>.log
run() {
  local name=$1
  shift
  local log="$OUT/logs/${name// /_}.log"
  if "$@" >"$log" 2>&1; then
    ok "$name"
    return 0
  fi
  bad "$name"
  echo "  ── 失败详情（$log 末尾 20 行）──"
  tail -20 "$log" | sed 's/^/  │ /'
  return 1
}

mkdir -p "$OUT/logs"

# ────────────────────────────── 1. 静态检查 ──────────────────────────────
say "1/3 静态检查"

static_ok=1
for file in lib/index.js lib/ai.js lib/birth-store.js client.js verify.mjs; do
  if node --check "$ROOT/$file" >"$OUT/logs/syntax-$(basename "$file").log" 2>&1; then
    ok "语法：$file"
  else
    bad "语法：$file"
    tail -5 "$OUT/logs/syntax-$(basename "$file").log" | sed 's/^/  │ /'
    static_ok=0
  fi
done

node --check "$APP/test-persistence.mjs" >"$OUT/logs/syntax-persistence.log" 2>&1 \
  && ok "语法：app/test-persistence.mjs" || bad "语法：app/test-persistence.mjs"

run "app 类型检查（tsc --noEmit）" bash -c "cd '$APP' && npx tsc --noEmit" || static_ok=0
run "app 内核回归（10 组）" bash -c "cd '$APP' && npm test --silent" || static_ok=0

if (( STATIC_ONLY )); then
  # 静态模式到此为止
  :
fi

# ────────────────────────────── 2. 构建 + 重启应用 ──────────────────────────────
instance_pid=""
cleanup() {
  # setsid 之后 $! 未必是 dsh 本体，按命令行精确匹配再收尸（避免误杀生产 3080 实例）
  local pattern="dsh --profile $PROFILE --no-open --host 127.0.0.1 --port $PORT"
  pkill -f "$pattern" 2>/dev/null
  sleep 1
  pkill -9 -f "$pattern" 2>/dev/null
  if [[ -n "$instance_pid" ]] && kill -0 "$instance_pid" 2>/dev/null; then
    kill -9 "$instance_pid" 2>/dev/null
  fi
}
trap cleanup EXIT INT TERM

wait_http() {
  local target=$1
  local expect=$2
  local tries=${3:-40}
  for ((i = 0; i < tries; i++)); do
    local code
    code=$(curl -s -o /dev/null -m 2 -w '%{http_code}' "$target" 2>/dev/null)
    if [[ "$code" == "$expect" ]]; then return 0; fi
    sleep 1
  done
  return 1
}

if (( STATIC_ONLY == 0 )); then
  say "2/3 构建内嵌应用并重启服务"
  if (( SKIP_BUILD )); then
    skip "next build（--no-build）"
  else
    run "next build" bash -c "cd '$APP' && npm run build --silent"
  fi
  if systemctl restart dsh-ziwei-app.service; then
    if wait_http "http://127.0.0.1:8815/ziwei/chart" 200 30; then
      ok "dsh-ziwei-app.service 已重启并在 8815 上响应"
    else
      bad "dsh-ziwei-app.service 重启后 8815 没起来"
    fi
  else
    bad "systemctl restart dsh-ziwei-app.service"
  fi

  # ────────────────────────────── 3. 隔离实例上的端到端验收 ──────────────────────────────
  say "3/3 端到端验收（隔离实例 :$PORT，DSH_HOME=$CHECK_HOME）"

  if [[ -z "$DSH_BIN" ]] || [[ ! -x "$DSH_BIN" ]]; then
    bad "找不到 dsh 可执行文件（可用 DSH_BIN=... 指定）"
  else
    rm -rf "$CHECK_HOME"
    mkdir -p "$CHECK_HOME/profiles/$PROFILE" "$CHECK_HOME/storages" "$CHECK_HOME/ziwei"
    # profile 用符号链接复用生产 profile 的依赖与配置（不复制 node_modules）
    for item in package.json node_modules cordis.yml cordis.patch.yml; do
      ln -s "$REAL_HOME/profiles/web/$item" "$CHECK_HOME/profiles/$PROFILE/$item"
    done
    # 模型凭据：没有它 /ziwei/ai 会报 no credential
    if [[ -f "$REAL_HOME/.credentials.yaml" ]]; then
      cp "$REAL_HOME/.credentials.yaml" "$CHECK_HOME/.credentials.yaml"
      chmod 600 "$CHECK_HOME/.credentials.yaml"
    else
      echo "  ! 警告：$REAL_HOME/.credentials.yaml 不存在，解读相关的断言大概率会失败" >&2
    fi
    # 新会话要选工作区：把生产的 workspace 列表带过来（只读用途，验收不写它）
    if [[ -f "$REAL_HOME/storages/workspace.json" ]]; then
      cp "$REAL_HOME/storages/workspace.json" "$CHECK_HOME/storages/workspace.json"
    fi
    # 生辰配置用独立的空文件，别碰生产那份
    export DSH_ZIWEI_BIRTH_FILE="$CHECK_HOME/ziwei/birth.json"

    echo '[]' > "$CHECK_HOME/cordis.patch.yml"

    (
      cd "$CHECK_HOME" || exit 1
      DSH_HOME="$CHECK_HOME" \
      DSH_ZIWEI_BIRTH_FILE="$DSH_ZIWEI_BIRTH_FILE" \
      DSH_PASSWORDS_ENV_FILE="$REAL_HOME/dsh-passwords/.env" \
      setsid nohup "$DSH_BIN" --profile "$PROFILE" --no-open --host 127.0.0.1 --port "$PORT" \
        >"$CHECK_HOME/dsh.log" 2>&1 &
      echo $! > "$CHECK_HOME/dsh.pid"
    )
    instance_pid=$(cat "$CHECK_HOME/dsh.pid" 2>/dev/null || true)

    url=""
    for ((i = 0; i < 60; i++)); do
      url=$(grep -o "http://127.0.0.1:$PORT/?token=[A-Za-z0-9_-]*" "$CHECK_HOME/dsh.log" 2>/dev/null | head -1)
      [[ -n "$url" ]] && break
      # 进程提前死了就别等了
      if [[ -n "$instance_pid" ]] && ! kill -0 "$instance_pid" 2>/dev/null; then break; fi
      sleep 2
    done

    if [[ -z "$url" ]]; then
      bad "隔离实例没起来（日志：$CHECK_HOME/dsh.log）"
      tail -20 "$CHECK_HOME/dsh.log" | sed 's/^/  │ /'
    else
      ok "隔离实例已启动"
      token=$(printf '%s' "$url" | sed -n 's/.*token=\([A-Za-z0-9_-]*\).*/\1/p')
      # Playwright 依赖的浏览器缓存可能被别的工具升级过（期望的 revision 不在缓存里）：
      # 本机只要还有任意一个 headless shell，就交给测试脚本兜底，避免整段验收跑不起来。
      if [[ -z "${DSH_ZIWEI_CHROMIUM:-}" ]]; then
        candidate=$(ls -d "$HOME"/.cache/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell 2>/dev/null | sort -V | tail -1 || true)
        [[ -n "$candidate" && -x "$candidate" ]] && export DSH_ZIWEI_CHROMIUM="$candidate"
      fi
      # 先跑生辰存储/管理的回归：它更轻，不受模型延迟影响；verify 里有真实模型会话，
      # 内存紧张时偶发把隔离实例拖死，放在后面，避免连带把这条也跑不成。
      if node "$APP/test-persistence.mjs" \
        --url "http://127.0.0.1:$PORT/ziwei/chart" --token "$token" --shots "$OUT/persistence" \
        >"$OUT/logs/persistence.log" 2>&1; then
        ok "app/test-persistence.mjs（生辰存储恢复 + 管理：列出全部 / 编辑单条 / 删除单条）"
      else
        bad "app/test-persistence.mjs（详见 logs/persistence.log）"
        grep '^FAIL' "$OUT/logs/persistence.log" 2>/dev/null | sed 's/^/  │ /' | head -10
      fi
      if node "$ROOT/verify.mjs" --url "$url" --out "$OUT" --ask >"$OUT/logs/verify.log" 2>&1; then
        ok "verify.mjs（面板 / 排盘 / 解读 / 合盘 / 古籍 / 百科 / 分享 / 最近生辰）"
      else
        bad "verify.mjs（详见 $OUT/report.json 与 logs/verify.log）"
        grep '^FAIL' "$OUT/logs/verify.log" 2>/dev/null | sed 's/^/  │ /' | head -10
      fi
    fi
  fi
fi

# ────────────────────────────── 汇总 ──────────────────────────────
say "汇总"
echo "  通过 $PASS · 失败 $FAIL · 跳过 $SKIPPED"
if (( FAIL > 0 )); then
  printf '  失败项：\n'
  for name in "${FAILED_NAMES[@]}"; do printf '    - %s\n' "$name"; done
  echo "  产物：$OUT"
  exit 1
fi
echo "  全部通过 ✅（产物：$OUT）"
