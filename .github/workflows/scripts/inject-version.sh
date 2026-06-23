#!/usr/bin/env bash
# 把 tag 名(如 v0.2.0)注入 4 个版本文件:
#   - package.json (root)
#   - packages/shared/package.json
#   - src-tauri/tauri.conf.json
#   - src-tauri/Cargo.toml
# 由 release.yml 在每个 build job 中调用。
#
# 要求环境:
#   - GITHUB_REF_NAME: tag 名称(如 v0.2.0)
#   - python3 (runner 预装)
#   - sed
set -euo pipefail

VERSION_NO_V="${GITHUB_REF_NAME#v}"
echo "::group::Injecting version $VERSION_NO_V"

# JSON: 用 Python 保持 UTF-8 安全(productName 是中文)
python3 - "$VERSION_NO_V" <<'PY'
import json
import pathlib
import sys

version = sys.argv[1]
paths = [
    "package.json",
    "packages/shared/package.json",
    "src-tauri/tauri.conf.json",
]
for p in paths:
    f = pathlib.Path(p)
    data = json.loads(f.read_text(encoding="utf-8"))
    data["version"] = version
    f.write_text(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"updated {p} -> version = {version}")
PY

# Cargo.toml: 仅改 `version = "..."` 那一行(唯一匹配 ^version =)
sed -i.bak -E "s/^version = \"[^\"]*\"/version = \"$VERSION_NO_V\"/" src-tauri/Cargo.toml
rm -f src-tauri/Cargo.toml.bak

echo "--- src-tauri/Cargo.toml version line ---"
grep '^version' src-tauri/Cargo.toml
echo "::endgroup::"
