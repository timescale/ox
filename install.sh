#!/bin/bash
# ox installer - Install script for macOS/Linux
# Usage: curl -fsSL https://get.ox.build | sh

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m' # No Color

REPO="timescale/ox"
INSTALL_DIR="$HOME/.local/bin"
BINARY_NAME="ox"

# Detect OS and architecture early (needed by functions)
OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Darwin)
    OS_TYPE="darwin"
    SHELL_RC="$HOME/.zshrc"
    ;;
  Linux)
    OS_TYPE="linux"
    if [ -f "$HOME/.zshrc" ]; then
      SHELL_RC="$HOME/.zshrc"
    else
      SHELL_RC="$HOME/.bashrc"
    fi
    ;;
  *)
    OS_TYPE="unknown"
    SHELL_RC="$HOME/.bashrc"
    ;;
esac

case "$ARCH" in
  x86_64)
    ARCH_TYPE="x64"
    ;;
  arm64|aarch64)
    ARCH_TYPE="arm64"
    ;;
  *)
    ARCH_TYPE="unknown"
    ;;
esac

# --- Function definitions ---

is_interactive() {
  # Check if /dev/tty is available for user interaction
  [ -t 0 ] || [ -e /dev/tty ]
}

prompt_yn() {
  local prompt="$1"
  local reply
  read -r -p "$prompt [y/N]: " reply < /dev/tty
  [[ "$reply" =~ ^[Yy]$ ]]
}

ensure_path_configured() {
  # Check if ~/.local/bin is in PATH
  if [[ ":$PATH:" != *":$INSTALL_DIR:"* ]]; then
    echo ""
    echo -e "${YELLOW}!${NC} $INSTALL_DIR is not in your PATH"

    # Check if rc file already has ~/.local/bin in PATH
    # shellcheck disable=SC2016
    if grep -qE '(^|:)\$HOME/\.local/bin(:|"|\s|$)|\.local/bin' "$SHELL_RC" 2>/dev/null; then
      : # PATH already configured
    elif is_interactive; then
      if prompt_yn "Add $INSTALL_DIR to PATH in $SHELL_RC?"; then
        {
          echo ""
          echo '# Added by ox installer'
          # shellcheck disable=SC2016
          echo 'export PATH="$HOME/.local/bin:$PATH"'
        } >> "$SHELL_RC"
        echo -e "${GREEN}✓${NC} Added $INSTALL_DIR to PATH in $SHELL_RC"
      else
        echo ""
        echo "To add it manually, run:"
        echo "  echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> $SHELL_RC"
      fi
    else
      echo ""
      echo "To add it manually, run:"
      echo "  echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> $SHELL_RC"
    fi

    # Export for current session
    export PATH="$INSTALL_DIR:$PATH"
    echo -e "${YELLOW}!${NC} Restart your shell or run: source $SHELL_RC"
  fi
}

configure_shell_completions() {
  echo ""
  echo -e "${BLUE}Configuring shell completions...${NC}"

  # Determine shell type from SHELL_RC
  local shell_type=""
  case "$SHELL_RC" in
    *zshrc*) shell_type="zsh" ;;
    *bashrc*|*bash_profile*) shell_type="bash" ;;
  esac

  if [ -z "$shell_type" ]; then
    echo -e "${YELLOW}!${NC} Could not detect shell type, skipping completion setup"
    echo "  Run 'ox completions' for manual setup instructions"
    return
  fi

  # Check if completion is already configured
  if grep -q 'ox complete' "$SHELL_RC" 2>/dev/null; then
    echo -e "${GREEN}✓${NC} Shell completions already configured in $SHELL_RC"
    return
  fi

  # For zsh, ensure compinit is loaded (required for compdef)
  local needs_compinit=false
  if [ "$shell_type" = "zsh" ]; then
    if ! grep -qE '(compinit|oh-my-zsh|prezto|zinit|antigen|zplug|zgenom)' "$SHELL_RC" 2>/dev/null; then
      needs_compinit=true
    fi
  fi

  if is_interactive; then
    if prompt_yn "Add shell completions to $SHELL_RC?"; then
      {
        if [ "$needs_compinit" = true ]; then
          echo ""
          echo "# Initialize zsh completions"
          echo "autoload -Uz compinit && compinit -i"
        fi
        echo ""
        echo "# Ox shell completions"
        echo "command -v ox &>/dev/null && source <(ox complete $shell_type)"
      } >> "$SHELL_RC"
      echo -e "${GREEN}✓${NC} Added shell completions to $SHELL_RC"
      if [ "$needs_compinit" = true ]; then
        echo -e "${GREEN}✓${NC} Added compinit initialization to $SHELL_RC"
      fi
    else
      echo ""
      echo "To add shell completions manually, add the following to $SHELL_RC:"
      if [ "$needs_compinit" = true ]; then
        echo "  autoload -Uz compinit && compinit -i"
      fi
      echo "  command -v ox &>/dev/null && source <(ox complete $shell_type)"
    fi
  else
    echo ""
    echo "To add shell completions manually, add the following to $SHELL_RC:"
    if [ "$needs_compinit" = true ]; then
      echo "  autoload -Uz compinit && compinit -i"
    fi
    echo "  command -v ox &>/dev/null && source <(ox complete $shell_type)"
  fi
}

verify_installation() {
  echo ""
  echo -e "${BLUE}Verifying installation...${NC}"

  # Give shell a moment to recognize new binary
  hash -r 2>/dev/null || true

  if command -v ox &> /dev/null; then
    echo -e "${GREEN}✓${NC} ox is installed!"
    echo ""
    ox --help 2>/dev/null || "$INSTALL_DIR/$BINARY_NAME" --help 2>/dev/null || true
    echo ""
    echo -e "${GREEN}${BOLD}Installation complete!${NC}"
    echo ""
    echo "Get started:"
    echo "  cd your-project"
    echo "  ox"
  else
    echo -e "${YELLOW}!${NC} ox installed but not found in PATH yet"
    echo ""
    echo "Restart your shell or run:"
    echo "  source $SHELL_RC"
    echo ""
    echo "Then verify with:"
    echo "  ox --help"
  fi
}

install_binary() {
  echo ""
  echo -e "${BLUE}Downloading pre-compiled binary...${NC}"

  # Check for unsupported platform
  if [ "$OS_TYPE" = "darwin" ] && [ "$ARCH_TYPE" = "x64" ]; then
    echo -e "${RED}Error: Pre-compiled binaries are not available for Intel Macs (darwin-x64).${NC}"
    echo ""
    echo "If you have an Apple Silicon Mac, the darwin-arm64 binary should work."
    echo ""
    echo "For development from source, clone the repo and use bun:"
    echo "  git clone https://github.com/$REPO.git"
    echo "  cd ox && ./bun i && ./bun link"
    echo ""
    exit 1
  fi

  BINARY_FILE="ox-${OS_TYPE}-${ARCH_TYPE}"

  # Create install directory if it doesn't exist
  mkdir -p "$INSTALL_DIR"

  # Download binary
  TEMP_DIR=$(mktemp -d)
  trap 'rm -rf "$TEMP_DIR"' EXIT

  # Support pinning to a specific version via OX_VERSION env var
  if [ -n "$OX_VERSION" ]; then
    DOWNLOAD_URL="https://github.com/$REPO/releases/download/v${OX_VERSION}/$BINARY_FILE"
    echo "Detected \$OX_VERSION in env. Fetching version ${OX_VERSION}..."
  else
    DOWNLOAD_URL="https://github.com/$REPO/releases/latest/download/$BINARY_FILE"
    echo "Fetching latest release..."
  fi

  if ! curl -fSL -o "$TEMP_DIR/$BINARY_FILE" "$DOWNLOAD_URL" 2>/dev/null; then
    echo -e "${RED}Error: Failed to download binary.${NC}"
    echo ""
    echo "This could mean:"
    echo "  - No releases have been published yet"
    if [ -n "$OX_VERSION" ]; then
      echo "  - Version ${OX_VERSION} does not exist"
    fi
    echo "  - The release doesn't have a binary for $OS_TYPE-$ARCH_TYPE"
    echo ""
    exit 1
  fi

  chmod +x "$TEMP_DIR/$BINARY_FILE"
  mv "$TEMP_DIR/$BINARY_FILE" "$INSTALL_DIR/$BINARY_NAME"

  echo -e "${GREEN}✓${NC} Installed to $INSTALL_DIR/$BINARY_NAME"

  # Ensure ~/.local/bin is in PATH
  ensure_path_configured

  # Configure shell completions
  configure_shell_completions

  verify_installation
}

# --- Main script ---

echo -e "${BLUE}${BOLD}"
echo "  _                                   "
echo " | |__   ___ _ __ _ __ ___   ___  ___ "
echo " | '_ \\ / _ \\ '__| '_ \` _ \\ / _ \\/ __|"
echo " | | | |  __/ |  | | | | | |  __/\\__ \\"
echo " |_| |_|\\___|_|  |_| |_| |_|\\___||___/"
echo -e "${NC}"
echo -e "${BLUE}Ox Installer${NC}"
echo ""

# Check for curl
if ! command -v curl &> /dev/null; then
  echo -e "${RED}Error: curl is required but not installed.${NC}"
  echo ""
  exit 1
fi

# Validate OS detection
if [ "$OS_TYPE" = "unknown" ]; then
  echo -e "${RED}Error: Unsupported OS: $OS${NC}"
  echo "Ox currently supports macOS and Linux."
  exit 1
fi

if [ "$ARCH_TYPE" = "unknown" ]; then
  echo -e "${RED}Error: Unsupported architecture: $ARCH${NC}"
  exit 1
fi

echo -e "${GREEN}✓${NC} Detected: $OS_TYPE-$ARCH_TYPE"

# Check for existing installation
EXISTING_OX=$(command -v ox 2>/dev/null || true)
if [ -n "$EXISTING_OX" ]; then
  echo -e "${YELLOW}!${NC} Existing ox found at: $EXISTING_OX"
fi

install_binary
