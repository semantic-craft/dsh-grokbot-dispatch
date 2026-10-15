#!/usr/bin/env bash
# Box-side client. Needs DSH_DISPATCH_URL and DSH_DISPATCH_KEY (e.g. `set -a; . ~/.config/dsh-grokbot-dispatch/env; set +a`).
#   dsh-dispatch.sh send <project> "<text starting with [Project: project]>" [timeout_seconds]
#   dsh-dispatch.sh status <job-id>
#   dsh-dispatch.sh wait <job-id>
set -euo pipefail
: "${DSH_DISPATCH_URL:?}" "${DSH_DISPATCH_KEY:?}"
auth=(-H "Authorization: Bearer ${DSH_DISPATCH_KEY}")
case "${1:-}" in
  send) body=$(python3 -c 'import json,sys; print(json.dumps({"project":sys.argv[1],"text":sys.argv[2],"timeout_seconds":int(sys.argv[3])}))' "$2" "$3" "${4:-1800}")
        curl -fsS -m 15 "${auth[@]}" -H 'content-type: application/json' -d "$body" "$DSH_DISPATCH_URL/v1/jobs";;
  status) curl -fsS -m 15 "${auth[@]}" "$DSH_DISPATCH_URL/v1/jobs/$2";;
  wait) while :; do out=$(curl -fsS -m 15 "${auth[@]}" "$DSH_DISPATCH_URL/v1/jobs/$2");
          case "$out" in *'"state":"running"'*) sleep 10;; *) echo "$out"; break;; esac; done;;
  *) sed -n 2,6p "$0"; exit 2;;
esac
