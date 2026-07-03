# Robert Williams / Detroit facial recognition wrongful arrest (2020)

Incident `AID-2020-0001`. In January 2020 Detroit police ran a blurry Shinola
store surveillance still through a Michigan State Police facial recognition
system, which falsely matched it to Robert Williams' expired driver's-license
photo. Officers acted on the unverified match and wrongfully arrested Williams in
front of his family, detaining him for ~30 hours. It is the first publicly
reported US wrongful arrest from a false facial recognition match. Detroit later
settled ($300,000) and adopted a reform requiring face-recognition results to be
corroborated with independent evidence before an arrest.

This is a **hypothetical** maker-checker framing (the real arrest was carried out
by human officers, not an automated system), but the adopted reform maps cleanly
onto the proxy: the facial recognition match is the "maker", and issuing an arrest
warrant is the irreversible "checker" action that must not fire off a raw match.

## What the demo shows

- `rw-detroit-face-match@1` and `rw-detroit-evidence-corroborate@1` are reversible
  and granted to `rw-detroit-identification-role` — **allowed**.
- Issuing an arrest warrant off the raw match is **DENIED** by deny-by-default
  (`skill_not_granted`): the identification role holds no warrant grant.
- `rw-detroit-arrest-warrant@1` is published `high` risk, so even the granted
  `rw-detroit-warrant-role` cannot issue it inline — **DENIED**
  (`high_risk_requires_gate`). A warrant only proceeds through a governed flow
  with an approval gate where the match is corroborated with independent evidence
  first — exactly the reform Detroit adopted.

Maps to the entry's `controlsThatBlock`: `approval_gate`, `high_risk_requires_gate`.

## Run

```
MAKERCHECKER_URL=http://localhost:3000 \
MAKERCHECKER_API_KEY=<admin key> \
node examples/robert-williams-detroit-facial-recognition-wrongful-arrest-2020/demo.mjs
```

Ends with `printTrailAndVerify`, printing the audit trail and verifying the hash
chain (`ok=true`).
