#!/bin/zsh
cd "${0:A:h}"
if ! command -v node >/dev/null 2>&1; then
  if [[ -s "$HOME/.nvm/nvm.sh" ]]; then
    source "$HOME/.nvm/nvm.sh"
  fi
fi
if ! command -v node >/dev/null 2>&1; then
  echo '需要 Node.js 22 或更高版本。安装后重新打开。'
  read '?按回车退出'
  exit 1
fi
node server.mjs --open
