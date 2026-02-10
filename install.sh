#!/bin/bash
# hermes installer - Install script for macOS/Linux
# Usage: gh api repos/timescale/hermes/contents/install.sh -H "Accept: application/vnd.github.raw" | bash

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m' # No Color

REPO="timescale/hermes"
INSTALL_DIR="$HOME/.local/bin"
BINARY_NAME="hermes"

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

    # Check if rc file needs modification
    if [ -f "$SHELL_RC" ]; then
      # shellcheck disable=SC2016
      if ! grep -q 'export PATH="\$HOME/.local/bin:\$PATH"' "$SHELL_RC"; then
        if is_interactive; then
          if prompt_yn "Add $INSTALL_DIR to PATH in $SHELL_RC?"; then
            {
              echo ""
              echo '# Added by hermes installer'
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
      fi
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
    echo "  Run 'hermes completions' for manual setup instructions"
    return
  fi

  # Check if completion is already configured
  if grep -q 'hermes complete' "$SHELL_RC" 2>/dev/null; then
    echo -e "${GREEN}✓${NC} Shell completions already configured in $SHELL_RC"
    return
  fi

  if is_interactive; then
    if prompt_yn "Add shell completions to $SHELL_RC?"; then
      {
        echo ""
        echo "# Hermes shell completions"
        echo "source <(hermes complete $shell_type)"
      } >> "$SHELL_RC"
      echo -e "${GREEN}✓${NC} Added shell completions to $SHELL_RC"
    else
      echo ""
      echo "To add shell completions manually, run:"
      echo "  echo 'source <(hermes complete $shell_type)' >> $SHELL_RC"
    fi
  else
    echo ""
    echo "To add shell completions manually, run:"
    echo "  echo 'source <(hermes complete $shell_type)' >> $SHELL_RC"
  fi
}

verify_installation() {
  echo ""
  echo -e "${BLUE}Verifying installation...${NC}"

  # Give shell a moment to recognize new binary
  hash -r 2>/dev/null || true

  if command -v hermes &> /dev/null; then
    echo -e "${GREEN}✓${NC} hermes is installed!"
    echo ""
    hermes --help 2>/dev/null || "$INSTALL_DIR/$BINARY_NAME" --help 2>/dev/null || true
    echo ""
    echo -e "${GREEN}${BOLD}Installation complete!${NC}"
    echo ""
    echo "Get started:"
    echo "  cd your-project"
    echo "  hermes"
  else
    echo -e "${YELLOW}!${NC} hermes installed but not found in PATH yet"
    echo ""
    echo "Restart your shell or run:"
    echo "  source $SHELL_RC"
    echo ""
    echo "Then verify with:"
    echo "  hermes --help"
  fi
}

install_binary() {
  echo ""
  echo -e "${BLUE}Downloading pre-compiled binary...${NC}"

  # Check for unsupported platform
  if [ "$OS_TYPE" = "darwin" ] && [ "$ARCH_TYPE" = "x64" ]; then
    echo -e "${RED}Error: Pre-compiled binaries are not available for Intel Macs (darwin-x64).${NC}"
    echo ""
    echo "Options:"
    echo "  1) Use option 2 (clone and link with bun) instead"
    echo "  2) If you have an Apple Silicon Mac, the darwin-arm64 binary should work"
    echo ""
    exit 1
  fi

  BINARY_FILE="hermes-${OS_TYPE}-${ARCH_TYPE}"

  # Create install directory if it doesn't exist
  mkdir -p "$INSTALL_DIR"

  # Download binary
  TEMP_DIR=$(mktemp -d)
  trap 'rm -rf "$TEMP_DIR"' EXIT

  echo "Fetching latest release..."
  if ! gh release download --repo "$REPO" --pattern "$BINARY_FILE" --dir "$TEMP_DIR" 2>/dev/null; then
    echo -e "${RED}Error: Failed to download binary.${NC}"
    echo ""
    echo "This could mean:"
    echo "  - No releases have been published yet"
    echo "  - The release doesn't have a binary for $OS_TYPE-$ARCH_TYPE"
    echo ""
    echo "Try option 2 (clone and link) instead, or ask a maintainer to publish a release."
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

install_dev() {
  echo ""
  echo -e "${BLUE}Installing from source...${NC}"

  # Check for bun
  if ! command -v bun &> /dev/null; then
    echo -e "${YELLOW}Bun is not installed. Installing bun first...${NC}"
    curl -fsSL https://bun.sh/install | bash
    export BUN_INSTALL="$HOME/.bun"
    export PATH="$BUN_INSTALL/bin:$PATH"
  fi

  echo -e "${GREEN}✓${NC} Bun is available"

  # Determine clone location
  DEFAULT_CLONE_DIR="$HOME/dev/hermes"
  read -r -p "Clone location [$DEFAULT_CLONE_DIR]: " CLONE_DIR < /dev/tty
  CLONE_DIR="${CLONE_DIR:-$DEFAULT_CLONE_DIR}"

  # Create parent directory if needed
  mkdir -p "$(dirname "$CLONE_DIR")"

  if [ -d "$CLONE_DIR" ]; then
    echo -e "${YELLOW}!${NC} Directory already exists: $CLONE_DIR"
    read -r -p "Update existing installation? [Y/n]: " update_choice < /dev/tty
    if [[ "$update_choice" =~ ^[Nn] ]]; then
      echo "Aborted."
      exit 0
    fi
    cd "$CLONE_DIR"
    git pull
  else
    echo "Cloning repository..."
    gh repo clone "$REPO" "$CLONE_DIR"
    cd "$CLONE_DIR"
  fi

  echo "Installing dependencies..."
  ./bun install

  echo "Linking globally..."
  ./bun link

  echo -e "${GREEN}✓${NC} Cloned to $CLONE_DIR and linked globally"

  # Configure shell completions
  configure_shell_completions

  echo ""
  echo -e "${YELLOW}Note:${NC} You may need to restart your shell or run:"
  echo "  source $SHELL_RC"
  echo ""
  echo "To update hermes in the future, run:"
  echo "  cd $CLONE_DIR && git pull && ./bun install"

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
echo -e "${BLUE}Hermes Installer${NC}"
echo ""

# Check for gh CLI
if ! command -v gh &> /dev/null; then
  echo -e "${RED}Error: GitHub CLI (gh) is required but not installed.${NC}"
  echo ""
  echo "Install it with:"
  echo "  macOS:  brew install gh"
  echo "  Linux:  https://github.com/cli/cli/blob/trunk/docs/install_linux.md"
  echo ""
  exit 1
fi

# Check gh authentication
if ! gh auth status &> /dev/null; then
  echo -e "${RED}Error: GitHub CLI is not authenticated.${NC}"
  echo ""
  echo "Run: gh auth login"
  echo ""
  exit 1
fi

# Check repo access
if ! gh repo view "$REPO" &> /dev/null; then
  echo -e "${RED}Error: Cannot access $REPO${NC}"
  echo ""
  echo "Make sure you have access to the repository and are authenticated."
  echo ""
  exit 1
fi

echo -e "${GREEN}✓${NC} GitHub CLI authenticated"

# Validate OS detection
if [ "$OS_TYPE" = "unknown" ]; then
  echo -e "${RED}Error: Unsupported OS: $OS${NC}"
  echo "Hermes currently supports macOS and Linux."
  exit 1
fi

if [ "$ARCH_TYPE" = "unknown" ]; then
  echo -e "${RED}Error: Unsupported architecture: $ARCH${NC}"
  exit 1
fi

echo -e "${GREEN}✓${NC} Detected: $OS_TYPE-$ARCH_TYPE"

# Check for existing installation
EXISTING_HERMES=$(command -v hermes 2>/dev/null || true)
if [ -n "$EXISTING_HERMES" ]; then
  echo -e "${YELLOW}!${NC} Existing hermes found at: $EXISTING_HERMES"
fi

# Installation method selection
echo ""
echo -e "${BOLD}Choose installation method:${NC}"
echo ""
echo "  1) Download pre-compiled binary (recommended)"
echo "     Fast install, no dependencies required"
echo ""
echo "  2) Clone repository and link with bun (for developers)"
echo "     Requires bun, allows you to modify the source"
echo ""

read -r -p "Enter choice [1-2]: " choice < /dev/tty

case $choice in
  1)
    install_binary
    ;;
  2)
    install_dev
    ;;
  *)
    echo -e "${RED}Invalid choice${NC}"
    exit 1
    ;;
esac
