# DEMO — what to do and what you should see

Everything runs on Nimiq **mainnet** with real NIM. Open https://rewind-rho.vercel.app **inside the Nimiq Pay app**
(Mini Apps → Custom URL). Nimiq Pay may first warn that the URL is not in its mini app list; that is expected until the
catalog listing is merged. In a normal browser Rewind says "Open Rewind inside the Nimiq Pay app" and cannot pay.

Screen text below is quoted from the code; chain values are examples from the mainnet run of 2026-09-14.

## 1. Demo Store: pay, ask for the money back, get it back (one phone, about 0.01 NIM)

| Step | You do | You should see |
|---|---|---|
| 1 | Open the app | **Demo Store** with the item "Refund Test — 0.01 NIM", the disclosure "Demo Store automatically approves valid 0.01 NIM refund requests…", and a Status card with the chain readable on mainnet (id 24) |
| 2 | Tap **Pay 0.01 NIM** and confirm in Nimiq Pay | The order page. Its status moves to **Payment verified on chain**, with "verified in block …" in the timeline |
| 3 | Tap **Request refund** | **Request a refund**: "Refund goes to" your wallet, the amount, a countdown, and "What am I signing?" with the exact text |
| 4 | Tap **Sign refund request** and confirm the signature in Nimiq Pay | The request is accepted and the Demo Store sends the refund at once. The note says how far the chain is: "The refund is not in a block yet.", "Waiting for confirmations (1 of 2).", or, if nothing is left to check, "Verified and approved by the Demo Store. The refund is on its way; this page keeps checking the chain." |
| 5 | Tap **Back to order** and wait | **Refund sent, waiting for the chain**, then **Refund verified on chain** |
| 6 | Tap **Receipt** | "This was a verified, merchant-approved refund…", the payment and the refund with "open in explorer" links, and the exact text that was signed |

On chain: a payment to the Demo Store treasury `NQ14 E6Y2 Y9CC 8GVY 1163 VBMJ YP54 QACN V4JD` with data
`RW1:P:<order>`, and a refund from that treasury to your wallet with data `RW1:R:<order>` (example: refund
`0989689ee542375659559e5a73196d3f3cf0e622f03785b2de553097e5006507`, block 61,603,650). Nimiq Pay charged no fee for the
payment in that run; the treasury pays the refund's fee.

Ways it refuses, each with its own screen:
- Cancel the payment in Nimiq Pay → "You cancelled the wallet dialog, so nothing was sent. No NIM has left your wallet."
  and **Open the unpaid order**.
- Cancel the signature → "You cancelled the signing dialog. Nothing was sent and nothing changed — the refund request
  has not been made yet."
- Sign with a different wallet → "That signature is not from the wallet this refund goes back to."
- Treasury below its floor or the chain unreadable → **Demo paused** instead of a Pay button.

## 2. Payment links: take a payment and refund it as a shop (one phone can play both roles)

| Step | You do | You should see |
|---|---|---|
| 1 | Tab **Payment links**, enter a shop name, tap **Create my payment link**, sign | Your shop with "Payments go to" your wallet, and a link builder |
| 2 | Enter an amount (up to 1 NIM) and tap **Copy link** | A link like `https://rewind-rho.vercel.app/#/pay/w-nq…?amount=1000&label=…` |
| 3 | Open the link in Nimiq Pay and tap **Pay …** | The order page; the payment is verified as in part 1 |
| 4 | Tap **Request refund**, sign | "Waiting for the shop to approve the refund." |
| 5 | Back in **Payment links**, tap **Sign in with wallet**, sign | Your shop's refund requests only |
| 6 | Tap **Approve**, sign | "Approved. Now send the refund from your wallet." |
| 7 | Tap **Send refund (…)** and confirm in Nimiq Pay | "Sent. Rewind marks it refunded once the chain shows it." The order then reads **Refund verified on chain** |

Rewind finds the shop's refund on chain by its `RW1:R:<order>` reference, the exact amount and a sender that is the shop's
wallet or a payment contract it funded; a look-alike from anyone else is ignored.

## For developers

`npm install`, `npm test`, `npm run build`, `npm run dev` (fake chain and fake wallet). Details and what is proven:
`README-DEV.md`.
