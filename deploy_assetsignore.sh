#!/bin/bash
set -e

# Adds .assetsignore so Cloudflare Workers Assets stops trying to upload
# node_modules (specifically the 122 MiB wrangler/workerd binary) as a
# static asset. Fixes: "Asset too large" during wrangler deploy.
# Run this from the root of your ai-content-research-os-ui repo in Codespaces.

cat << 'EOF' > ./.assetsignore
# Cloudflare Workers Assets ignore file
# Prevents dev-only files (especially node_modules, which contains the
# 122 MiB wrangler/workerd binary) from being uploaded as static assets.
# This is what was causing: "Asset too large" during `wrangler deploy`.

node_modules
.git
.github
.wrangler
.gitignore
.assetsignore
package.json
package-lock.json
bun.lockb
bun.lock
wrangler.jsonc
wrangler.toml
*.md
.env
.env.*
EOF

# --- Verification ---
echo "✅ .assetsignore written"
cat ./.assetsignore
grep -q "^node_modules$" ./.assetsignore && echo "✅ node_modules excluded"
echo ""
echo "Next: git add .assetsignore && git commit -m \"fix: exclude node_modules from Workers assets upload\" && git push"
echo "Then retry the Cloudflare Pages deployment."
