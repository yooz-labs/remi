#!/bin/bash
set -euo pipefail

VERSION="${1:?Usage: update-homebrew.sh <version>}"

# Validate semver
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-.+)?$ ]]; then
  echo "Error: VERSION must be semver (e.g. 1.2.3), got: $VERSION" >&2
  exit 1
fi

PLATFORMS=("darwin-arm64" "darwin-x64" "linux-arm64" "linux-x64")
declare -A SHAS

echo "==> Fetching SHA-256 hashes from npm registry..." >&2
for PLAT in "${PLATFORMS[@]}"; do
  URL="https://registry.npmjs.org/@yooz-labs/remi-${PLAT}/-/remi-${PLAT}-${VERSION}.tgz"
  SHA=$(curl -sfL "$URL" | shasum -a 256 | cut -d' ' -f1)
  if [[ -z "$SHA" ]]; then
    echo "Error: Failed to fetch $URL" >&2
    exit 1
  fi
  SHAS[$PLAT]="$SHA"
  echo "  $PLAT: $SHA" >&2
done

FORMULA="class Remi < Formula
  desc \"Remote monitor for Claude Code CLI sessions\"
  homepage \"https://github.com/yooz-labs/remi\"
  version \"${VERSION}\"
  license :cannot_represent

  on_macos do
    if Hardware::CPU.arm?
      url \"https://registry.npmjs.org/@yooz-labs/remi-darwin-arm64/-/remi-darwin-arm64-${VERSION}.tgz\"
      sha256 \"${SHAS[darwin-arm64]}\"
    else
      url \"https://registry.npmjs.org/@yooz-labs/remi-darwin-x64/-/remi-darwin-x64-${VERSION}.tgz\"
      sha256 \"${SHAS[darwin-x64]}\"
    end
  end

  on_linux do
    if Hardware::CPU.arm?
      url \"https://registry.npmjs.org/@yooz-labs/remi-linux-arm64/-/remi-linux-arm64-${VERSION}.tgz\"
      sha256 \"${SHAS[linux-arm64]}\"
    else
      url \"https://registry.npmjs.org/@yooz-labs/remi-linux-x64/-/remi-linux-x64-${VERSION}.tgz\"
      sha256 \"${SHAS[linux-x64]}\"
    end
  end

  def install
    bin.install \"bin/remi\"
  end

  test do
    assert_match \"remi #{version}\", shell_output(\"#{bin}/remi --version\")
  end
end
"

echo "==> Generated formula for remi ${VERSION}" >&2
echo "$FORMULA"
