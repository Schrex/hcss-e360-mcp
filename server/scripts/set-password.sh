#!/bin/sh
# Prompts for the connector password (hidden), stores only its PBKDF2 hash, and sets TOKEN_EPOCH if missing.
set -e
cd "$(dirname "$0")/.."
HASH=$(python3 -c 'import hashlib,os,base64,getpass;s=os.urandom(16);p=getpass.getpass("Connector password: ");q=getpass.getpass("Again: ");assert p==q,"Passwords differ";assert len(p)>=12,"Too short";print("pbkdf2$30000$"+base64.b64encode(s).decode()+"$"+base64.b64encode(hashlib.pbkdf2_hmac("sha256",p.encode(),s,30000)).decode())')
printf '%s' "$HASH" | npx wrangler secret put ACCESS_PASSWORD_HASH
if ! npx wrangler secret list 2>/dev/null | grep -q '"TOKEN_EPOCH"'; then
  openssl rand -hex 16 | npx wrangler secret put TOKEN_EPOCH
fi
echo "Done."
