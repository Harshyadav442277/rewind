# Rewind — verified refunds for NIM

NIM merchants can refund a payment safely, because the buyer proves control of the wallet that paid by signing a
one-time refund request inside Nimiq Pay, and both the payment and the refund are verified on chain and linked.

Live: https://rewind-rho.vercel.app (Nimiq mainnet). Open it inside Nimiq Pay.

How "the wallet that paid" is found: Nimiq Pay pays out of an HTLC contract that the user's wallet funded, and signs
with that funding wallet. An HTLC cannot receive a refund, so Rewind reads the paying account from the chain, follows
an HTLC to the wallet that funded it, sends the refund there, and accepts a signature only from that wallet.

Status: in development for the Nimiq Mini Apps Competition, Cycle II. What has and has not been verified is in
`README-DEV.md`.

License: MIT.
