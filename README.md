# Rewind — verified refunds for NIM

NIM merchants can refund a payment safely: a refund can only go back to the address that paid, read from the chain,
the buyer requests it with a one-time signed message inside Nimiq Pay, and both the payment and the refund are
verified on chain and linked.

Live: https://rewind-rho.vercel.app (Nimiq mainnet). Open it inside Nimiq Pay.

Status: in development for the Nimiq Mini Apps Competition, Cycle II. What has and has not been verified is in
`README-DEV.md`.

Known limitation: Nimiq Pay signs with a different address of the same wallet than the one it pays from, and the
mini-app SDK does not let an app choose either. So the signature is a request, not proof of owning the paying
address. Anyone holding an order id can ask for its refund, but the NIM can only return to the address that paid.

License: MIT.
