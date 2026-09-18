# How to assemble and open the PR

This directory is the submission package. It is NOT yet in the right place:
the PR must add exactly one directory to a fork of `xagentAI/xagt-plugin` at
`submissions/mcp-hackathon/faroukobayanju-abstain/`.

## Order matters — doing this backwards means redoing it

    freeze code ──▶ push to YOUR public repo ──▶ capture the 40-char sha
                                                        │
                        ┌───────────────────────────────┘
                        ▼
            deploy to Vercel ──▶ verify /health echoes that exact sha
                        │
                        ▼
            fill placeholders ──▶ vendor source/ ──▶ open PR

## 1. Push this repo public, capture the sha

    gh repo create abstain --public --source=. --remote=origin --push
    COMMIT=$(git rev-parse HEAD); echo $COMMIT

## 2. Deploy, then confirm the binding

    vercel --prod
    # set ABSTAIN_WRITE_KEY (and optionally NEXUS_API_KEY, NEXUS_MODE=live,
    # UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN) in the Vercel dashboard
    curl -s https://<deployment>/health
    curl -s https://<deployment>/.well-known/xagent-verification.json

Both must report the SAME 40-char sha as $COMMIT. If they do not, stop and fix
that before anything else — it is a hard gate.

## 3. Fill every placeholder

    REPLACE_ME                 -> your github owner / vercel deployment host
    REPLACE_WITH_40_CHAR_SHA   -> $COMMIT
    REPLACE_WITH_DEMO_KEY      -> the ABSTAIN_WRITE_KEY you set on Vercel
    REPLACE_WITH_CONTACT       -> your contact channel

Files containing placeholders: SUBMISSION.md, submission.json,
verification/README.md.

## 4. Assemble into a fork and validate offline

    gh repo fork xagentAI/xagt-plugin --clone --remote=false
    cd xagt-plugin && git checkout -b faroukobayanju-abstain
    mkdir -p submissions/mcp-hackathon/faroukobayanju-abstain
    cp -R <this-repo>/submission/{SUBMISSION.md,submission.json,RIGHTS.md,verification} \
          submissions/mcp-hackathon/faroukobayanju-abstain/
    rm submissions/mcp-hackathon/faroukobayanju-abstain/PACKAGE.md 2>/dev/null

    # Vendor the complete source, excluding build output and deps.
    mkdir -p submissions/mcp-hackathon/faroukobayanju-abstain/source
    cd <this-repo> && git archive HEAD | \
      tar -x -C <fork>/submissions/mcp-hackathon/faroukobayanju-abstain/source

    # Offline preflight provided by the submission repo:
    cd <fork> && npm run validate:submission -- \
      --dir submissions/mcp-hackathon/faroukobayanju-abstain

## 5. Last check before opening the PR

    [ ] no nxk_ anywhere:  git -C <fork> grep -rn "nxk_" || echo clean
    [ ] no .env committed
    [ ] the sha in /health, /.well-known, and submission.json are identical
    [ ] npm ci && npm test passes from a clean clone of source/  (162 tests)
    [ ] SUBMISSION.md framing is pre-trade execution control — NOT risk
        scoring, NOT compliance, NOT security analysis (excluded categories)

Then open one PR adding exactly that one directory.
