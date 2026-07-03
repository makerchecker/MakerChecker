# Choice Home Warranty chatbot committed a $3,000 AC payout (AID-2024-0001)

In September 2024, Choice Home Warranty's newly deployed customer-service
chatbot (live about a week) told a customer in writing, under the company's
name, that it would "proceed with the payout option of $3,000.00 as per your
request" toward an air-conditioner replacement — a binding claim outcome the
company had never authorized. The company first disowned the promise ("the
chatbot did it") and paid only after KSL Investigates intervened.

## What this demo shows

Governed through the MakerChecker proxy (no flow engine), the same style as the
other incident demos:

- **Allowed (positive control):** the chatbot replies to the customer and
  assesses the AC claim — reversible actions granted to the chatbot role.
- **DENIED — `skill_not_granted`:** the chatbot tries to commit the $3,000
  payout. It holds no payout grant, so deny-by-default stops it from ever
  stating a binding dollar figure — the exact promise the real chatbot made.
- **DENIED — `high_risk_requires_gate`:** even the claims-adjuster role that
  holds the payout grant cannot commit inline. A payout is a high-risk skill and
  must pass an approval gate (a human checker) before any figure is communicated.

The demo ends by printing the audit trail and verifying the hash chain
(`ok=true`).

## Controls

`controlsThatBlock`: `approval_gate`, `high_risk_requires_gate` — modeled here as
deny-by-default on the chatbot plus a high-risk gate on the payout-commit skill.

## Run

```
cd build-repros
MAKERCHECKER_URL=http://localhost:3000 \
MAKERCHECKER_API_KEY=mk_... \
node examples/choice-home-warranty-chatbot-3000-ac-payout-2024/demo.mjs
```
