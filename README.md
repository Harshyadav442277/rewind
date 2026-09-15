# Rewind — verified refunds for NIM

**NIM sellers can refund a payment safely inside Nimiq Pay**, because Rewind reads the payment on chain, resolves the
wallet that funded it, accepts a one-time refund request signed only by that wallet, and verifies the refund
transaction on chain and links it to the payment.

**Live:** https://rewind-rho.vercel.app (Nimiq mainnet). Open it inside the Nimiq Pay app (Mini Apps → Custom URL).

**For:** people who sell for NIM directly, and their buyers.

**Try it alone:** the Demo Store sells one item for 0.01 NIM. Pay it, tap Request refund, sign once, and
the Demo Store sends your 0.01 NIM back from its capped treasury. The receipt links both transactions to the explorer.

**Sell with it:** Payment links. Any wallet signs once to become a shop and gets a link for an amount. A buyer pays
through the link; the shop sees signed refund requests, approves one, and sends the refund from Nimiq Pay. Rewind finds
that refund on chain by its reference and marks the order refunded only when the chain agrees.

How the refund destination is found: Nimiq Pay pays out of an HTLC contract that the user's wallet funded, and signs
with that wallet. An HTLC cannot receive a refund, so Rewind reads the paying account from the chain, follows an HTLC to
the wallet that funded it, sends the refund there, and accepts a signature only from that wallet.

A refund is a second, verified transaction that a merchant approved. NIM payments are not reversible, and Rewind does
not claim they are.

Status: built for the Nimiq Mini Apps Competition, Cycle II. What is proven, and what is not: `README-DEV.md`.

License: MIT.
