# eviCore "the dial" prior-authorization algorithm (AID-2024-0002)

A 2024 ProPublica / Capitol Forum investigation reported that eviCore, a
Cigna-owned prior-authorization contractor serving ~100 million people, used an
AI screen insiders call "the dial" as the first step on coverage requests. By
design the algorithm could **auto-approve or flag** a request for human review,
but it could **not itself deny**. The reported harm came from tuning the dial's
routing threshold to push more requests into human review — raising downstream
denials — while the doctors who issued the final denials sat inside the same
firm that profited from them. The check existed on paper; it was conflicted, not
missing.

## What this demo shows

The entry's controls are `approval_gate` + `sod_violation`. The proxy enforces
them three ways:

1. **Separation of duties (deny-by-default).** The dial (maker) holds grants to
   `evicore-pa-auto-approve@1` and `evicore-pa-flag-review@1` but **no** grant to
   `evicore-pa-deny-commit@1`. A denial issued directly by the algorithm is
   refused with `skill_not_granted` — the maker can never also be the denier.

2. **Bounded tuning (limit_violation).** `evicore-dial-retune@1` is capped at a
   small per-adjustment `thresholdDelta`. A modest clinical tweak (+3) passes; a
   large cost-driven swing (+40) to spike denials trips `limit_amount`.

3. **Approval gate (high_risk_requires_gate).** The final denial commit is a
   high-risk skill. Even the in-house medical-reviewer role that *holds* the
   grant cannot deny inline — it is refused with `high_risk_requires_gate` and
   must run through a governed flow behind an approval gate decided by an
   independent party, the separation the conflicted same-firm checker lacked.

Positive controls: the dial's auto-approve, flag-for-review, and in-bounds
clinical retune are all allowed, proving the demo does not merely block
everything.

## Run

```
cd examples/../..   # repo root (build-repros)
MAKERCHECKER_URL=http://localhost:3000 \
MAKERCHECKER_API_KEY=<admin key> \
node examples/evicore-the-dial-prior-authorization-algorithm/demo.mjs
```

Expected: three DENIED lines (`skill_not_granted`, `limit_amount`,
`high_risk_requires_gate`) and a final `audit chain: ok=true`.
