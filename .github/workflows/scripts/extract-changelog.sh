#!/usr/bin/env bash
# 从 CHANGELOG.md 抓 ## [X.Y.Z] - DATE 段,写到 GITHUB_OUTPUT.body。
# 找不到时返回非零(exit 1),由 caller 用 continue-on-error 兜底。
#
# 兼容性: macOS BWK awk / GNU awk / POSIX sed 全兼容。
# 故意不用 gawk 专有的 match() 数组捕获,因为 macos-latest runner 默认 awk 是 BWK。
#
# 算法: 用 awk 扫描 CHANGELOG.md,
#   - 见到 /^## \[/ 行,用 sed 取中括号里的版本号字符串
#   - 当前行匹配目标版本 → 进入 in_block
#   - 已 in_block 时又见到 /^## \[/ → 退出(不打印)
#   - in_block 状态时把行累加进 collected
set -euo pipefail

VERSION_NO_V="${GITHUB_REF_NAME#v}"
echo "::group::Extracting CHANGELOG section for v$VERSION_NO_V"

BODY=$(awk -v target="[$VERSION_NO_V]" '
  /^## \[/ {
    if (in_block) { exit }
    if (index($0, target) > 0) { in_block = 1; next }
  }
  in_block { printf "%s\n", $0 }
  END {
    if (!in_block) exit 1
  }
' CHANGELOG.md)

if [ -z "$BODY" ]; then
  echo "::endgroup::"
  echo "::error::No CHANGELOG section found for v$VERSION_NO_V"
  exit 1
fi

{
  echo "body<<EOF"
  echo "$BODY"
  echo "EOF"
} >> "$GITHUB_OUTPUT"

LINE_COUNT=$(echo "$BODY" | wc -l | tr -d ' ')
echo "Extracted ${LINE_COUNT} lines for v$VERSION_NO_V"
echo "::endgroup::"
