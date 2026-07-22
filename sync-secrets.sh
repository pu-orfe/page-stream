#!/bin/bash
set -euo pipefail

# ANSI color codes for rich, beautiful terminal output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

SECRETS_FILE="/Users/publicdisplays/Downloads/page-stream/.env.secrets.sh"
REPO="pu-orfe/page-stream-config"

echo -e "${BLUE}${BOLD}======================================================================${NC}"
echo -e "${CYAN}${BOLD}                 DYNAMIC GITHUB SECRETS UPLOADER / SYNCER             ${NC}"
echo -e "${BLUE}${BOLD}======================================================================${NC}"

if [ ! -f "$SECRETS_FILE" ]; then
  echo -e "${RED}✗ Error: Secrets file $SECRETS_FILE not found.${NC}"
  exit 1
fi

echo -e "Reading secrets from: ${CYAN}$SECRETS_FILE${NC}"
echo -e "Uploading to GitHub repo: ${CYAN}$REPO${NC}\n"

# Check if user is logged into gh
if ! gh auth status &> /dev/null; then
  echo -e "${RED}✗ Error: You are not logged into 'gh' CLI. Please run 'gh auth login' first.${NC}"
  exit 1
fi

# Read the file line by line, extracting export values
COUNT=0
while IFS= read -r line || [ -n "$line" ]; do
  # Match: export VAR='val' or export VAR="val"
  if [[ "$line" =~ ^export\ ([A-Z0-9_]+)=[\'\"](.*)[\'\"]$ ]]; then
    KEY="${BASH_REMATCH[1]}"
    VAL="${BASH_REMATCH[2]}"
    
    echo -e "  Uploading secret ${YELLOW}${KEY}${NC}..."
    # Call gh CLI to store the secret securely
    if echo -n "$VAL" | gh secret set "$KEY" --repo "$REPO" &> /dev/null; then
      echo -e "  ${GREEN}✓ Successfully synced $KEY${NC}"
      COUNT=$((COUNT+1))
    else
      echo -e "  ${RED}✗ Failed to sync $KEY${NC}"
    fi
  fi
done < "$SECRETS_FILE"

echo -e "\n${GREEN}${BOLD}✓ All done! Successfully synced $COUNT secrets to $REPO!${NC}"
