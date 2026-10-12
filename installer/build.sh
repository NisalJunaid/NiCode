#!/usr/bin/env bash
# Bundles installer/ into one self-contained file: dist/nicode-install.sh
# (lib/*.sh inlined, bin/nicode embedded) so a fresh server needs only `curl` to install.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
out="$here/../dist/nicode-install.sh"
mkdir -p "$(dirname "$out")"

{
  echo '#!/usr/bin/env bash'
  echo '# niCode installer — bundled by installer/build.sh. Do not edit; edit installer/ and rebuild.'
  echo 'NICODE_BUNDLED=1'
  for f in "$here"/lib/*.sh; do
    echo
    echo "# ───── lib/$(basename "$f") ─────"
    grep -v '^# shellcheck shell=bash' "$f"
  done
  echo
  echo '# ───── bin/nicode (embedded) ─────'
  echo 'nicode_cli_source() {'
  echo "cat <<'NICODE_CLI_EOF'"
  cat "$here/bin/nicode"
  echo 'NICODE_CLI_EOF'
  echo '}'
  echo
  echo '# ───── install.sh ─────'
  tail -n +2 "$here/install.sh"
} >"$out"

chmod +x "$out"
bash -n "$out"
echo "Built $out ($(wc -c <"$out") bytes)"
