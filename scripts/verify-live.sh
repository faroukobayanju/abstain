#!/usr/bin/env bash
# Verify a deployed Abstain instance end to end.
#
#   ./scripts/verify-live.sh https://your-app.vercel.app YOUR_WRITE_KEY
#
# Exits non-zero on the first failure, so it doubles as a pre-submission gate.
set -uo pipefail

URL="${1:-https://x-agent-six.vercel.app}"
KEY="${2:-}"
PASS=0; FAIL=0

ok()   { printf '  \033[32mPASS\033[0m  %s\n' "$1"; PASS=$((PASS+1)); }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n     expected: %s\n     got:      %s\n' "$1" "$2" "$3"; FAIL=$((FAIL+1)); }
head2() { printf '\n\033[1m%s\033[0m\n' "$1"; }

jqv() { python3 -c "import json,sys;d=json.load(sys.stdin);print(d$1)" 2>/dev/null || echo "__ERR__"; }

head2 "1. Hard gate: /health has no external dependencies"
BODY=$(curl -s --max-time 20 "$URL/health")
STATUS=$(printf '%s' "$BODY" | jqv "['status']")
COMMIT=$(printf '%s' "$BODY" | jqv "['commit']")
REVIEWABLE=$(printf '%s' "$BODY" | jqv "['commit_reviewable']")
[ "$STATUS" = "ok" ] && ok "status is ok" || bad "status" "ok" "$STATUS"
[ "$REVIEWABLE" = "True" ] && ok "commit is a real 40-char sha: $COMMIT" || bad "commit_reviewable" "True" "$REVIEWABLE"
HDR=$(curl -s -D - -o /dev/null --max-time 20 "$URL/health" | tr -d '\r' | awk -F': ' '/^x-source-commit/{print $2}')
[ "$HDR" = "$COMMIT" ] && ok "x-source-commit header matches body" || bad "x-source-commit" "$COMMIT" "$HDR"

head2 "2. Hard gate: deployment proof"
WK=$(curl -s --max-time 20 "$URL/.well-known/xagent-verification.json")
SCHEMA=$(printf '%s' "$WK" | jqv "['schemaVersion']")
SLUG=$(printf '%s' "$WK" | jqv "['slug']")
WKCOMMIT=$(printf '%s' "$WK" | jqv "['commit']")
[ "$SCHEMA" = "1" ] && ok "schemaVersion is 1" || bad "schemaVersion" "1" "$SCHEMA"
[ -n "$SLUG" ] && ok "slug is $SLUG" || bad "slug" "non-empty" "$SLUG"
[ "$WKCOMMIT" = "$COMMIT" ] && ok "commit matches /health" || bad "commit" "$COMMIT" "$WKCOMMIT"

head2 "3. Dependencies (non-gating)"
READY=$(curl -s --max-time 25 "$URL/v1/ready")
printf '  %s\n' "$READY"
printf '%s' "$READY" | grep -q '"nexus":true' && ok "Nexus reachable" || bad "nexus" "true" "$READY"
printf '%s' "$READY" | grep -q '"store":true' && ok "receipt store reachable" || bad "store" "true" "$READY"

head2 "4. Write endpoint fails closed without a key"
CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 -X POST "$URL/v1/evaluate" \
  -H 'content-type: application/json' -d '{"symbol":"BTC/USDT","side":"BUY","notional":15000}')
[ "$CODE" = "401" ] && ok "401 without X-ABSTAIN-KEY" || bad "no-key status" "401" "$CODE"

if [ -z "$KEY" ]; then
  printf '\n  (skipping authenticated checks — pass the write key as argument 2)\n'
else
  head2 "5. Input validation names the offending field"
  V=$(curl -s --max-time 20 -X POST "$URL/v1/evaluate" -H 'content-type: application/json' \
      -H "x-abstain-key: $KEY" -d '{"symbol":"BTC"}')
  FIELD=$(printf '%s' "$V" | jqv "['field']")
  [ "$FIELD" = "symbol" ] && ok "400 naming field 'symbol'" || bad "validation field" "symbol" "$FIELD"

  head2 "6. Capability call writes a receipt"
  BEFORE=$(curl -s --max-time 20 "$URL/v1/receipts" | jqv "['total']")
  R=$(curl -s --max-time 40 -X POST "$URL/v1/evaluate" -H 'content-type: application/json' \
      -H "x-abstain-key: $KEY" -d '{"symbol":"BTC/USDT","side":"BUY","notional":15000,"policy":"strict"}')
  VERDICT=$(printf '%s' "$R" | jqv "['verdict']")
  ASOF=$(printf '%s' "$R" | jqv "['as_of']")
  SEQ=$(printf '%s' "$R" | jqv "['receipt']['seq']")
  case "$VERDICT" in
    EXECUTE|ABSTAIN|NO_TRADE) ok "verdict is $VERDICT" ;;
    *) bad "verdict" "EXECUTE|ABSTAIN|NO_TRADE" "$VERDICT" ;;
  esac
  printf '%s' "$ASOF" | grep -qE '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' && ok "as_of recorded: $ASOF" || bad "as_of" "YYYY-MM-DD" "$ASOF"
  AFTER=$(curl -s --max-time 20 "$URL/v1/receipts" | jqv "['total']")
  [ "$AFTER" -gt "$BEFORE" ] 2>/dev/null && ok "chain grew $BEFORE -> $AFTER (receipt seq $SEQ)" || bad "chain growth" ">$BEFORE" "$AFTER"

  head2 "7. Same signal, two policies, two hashes"
  H1=$(curl -s --max-time 40 -X POST "$URL/v1/evaluate" -H 'content-type: application/json' -H "x-abstain-key: $KEY" \
       -d '{"symbol":"BTC/USDT","side":"BUY","notional":15000,"policy":"strict"}' | jqv "['policy_hash']")
  H2=$(curl -s --max-time 40 -X POST "$URL/v1/evaluate" -H 'content-type: application/json' -H "x-abstain-key: $KEY" \
       -d '{"symbol":"BTC/USDT","side":"BUY","notional":15000,"policy":"permissive"}' | jqv "['policy_hash']")
  [ "$H1" != "$H2" ] && [ "$H1" != "__ERR__" ] && ok "strict != permissive policy_hash" || bad "policy_hash" "different" "$H1 vs $H2"
fi

head2 "8. The closer: anyone can recompute the chain"
VER=$(curl -s --max-time 25 "$URL/v1/verify")
VOK=$(printf '%s' "$VER" | jqv "['ok']")
VLEN=$(printf '%s' "$VER" | jqv "['length']")
[ "$VOK" = "True" ] && ok "chain verifies, length $VLEN" || bad "verify" "ok:true" "$VER"

head2 "9. Receipt is self-consistent (recompute one hash independently)"
if [ "${VLEN:-0}" != "0" ] && [ "$VLEN" != "__ERR__" ]; then
  curl -s --max-time 20 "$URL/v1/receipts/1" > /tmp/abstain_r1.json
  python3 - <<'PY' && ok "seq 1 hash recomputes correctly" || bad "receipt hash" "match" "mismatch"
import json,hashlib,sys
r=json.load(open('/tmp/abstain_r1.json'))
stored=r.pop('hash')
def srt(v):
    if isinstance(v,list): return [srt(x) for x in v]
    if isinstance(v,dict): return {k:srt(v[k]) for k in sorted(v) if v[k] is not None or True}
    return v
canon=json.dumps(srt(r),separators=(',',':'),ensure_ascii=False)
calc='sha256:'+hashlib.sha256(canon.encode()).hexdigest()
sys.exit(0 if calc==stored else 1)
PY
else
  printf '  (no receipts yet)\n'
fi

printf '\n\033[1m%d passed, %d failed\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
