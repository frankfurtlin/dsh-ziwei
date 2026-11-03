#!/usr/bin/env bash
#
# 安装 git 钩子：提交前自动跑静态自检（语法 / 类型 / 内核回归），失败就拦下提交。
# 端到端全量验收请手动跑 scripts/check.sh（要起隔离实例，几十秒）。
#
set -euo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
HOOK="$ROOT/.git/hooks/pre-commit"

if [[ ! -d "$ROOT/.git" ]]; then
  echo "这不是 git 仓库：$ROOT" >&2
  exit 1
fi

cat > "$HOOK" <<'HOOKEOF'
#!/usr/bin/env bash
# 由 plugins/dsh-ziwei/scripts/install-hooks.sh 生成
set -euo pipefail
ROOT=$(git rev-parse --show-toplevel)
exec "$ROOT/scripts/check.sh" --static
HOOKEOF
chmod +x "$HOOK"
echo "已安装 pre-commit：$HOOK"
echo "（跳过用 git commit --no-verify）"
