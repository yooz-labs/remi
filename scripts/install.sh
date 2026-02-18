#!/bin/bash
set -euo pipefail

REPO="yooz-labs/remi"
INSTALL_DIR="${HOME}/.local/bin"

# Detect platform and architecture
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"

case "${OS}" in
  darwin) PLATFORM="darwin" ;;
  linux)  PLATFORM="linux" ;;
  *)
    echo "Unsupported OS: ${OS}"
    exit 1
    ;;
esac

case "${ARCH}" in
  x86_64|amd64) ARCH_SUFFIX="x64" ;;
  arm64|aarch64) ARCH_SUFFIX="arm64" ;;
  *)
    echo "Unsupported architecture: ${ARCH}"
    exit 1
    ;;
esac

BINARY_NAME="remi-${PLATFORM}-${ARCH_SUFFIX}"

# Get latest release tag if not specified
VERSION="${1:-latest}"
if [ "${VERSION}" = "latest" ]; then
  VERSION=$(curl -sL "https://api.github.com/repos/${REPO}/releases/latest" | grep '"tag_name"' | head -1 | cut -d'"' -f4)
  if [ -z "${VERSION}" ]; then
    echo "Failed to fetch latest release version"
    exit 1
  fi
fi

DOWNLOAD_URL="https://github.com/${REPO}/releases/download/${VERSION}/${BINARY_NAME}"

echo "Installing remi ${VERSION} (${PLATFORM}-${ARCH_SUFFIX})..."

# Create install directory
mkdir -p "${INSTALL_DIR}"

# Download binary
echo "Downloading ${DOWNLOAD_URL}..."
curl -fSL "${DOWNLOAD_URL}" -o "${INSTALL_DIR}/remi"
chmod +x "${INSTALL_DIR}/remi"

echo "Installed remi to ${INSTALL_DIR}/remi"

# Check if install dir is in PATH
if ! echo "${PATH}" | tr ':' '\n' | grep -q "^${INSTALL_DIR}$"; then
  echo ""
  echo "Add ${INSTALL_DIR} to your PATH:"
  echo "  export PATH=\"${INSTALL_DIR}:\${PATH}\""
fi

echo ""
echo "Run 'remi --version' to verify installation."
