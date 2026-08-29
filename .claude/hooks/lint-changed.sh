#!/bin/bash
# 取出本次被改动的文件路径
file=$(jq -r '.tool_input.file_path')

# 只对 TS 文件跑 lint
if [[ "$file" == *.ts || "$file" == *.tsx ]]; then
  pnpm eslint "$file" >&2 || exit 2
fi
