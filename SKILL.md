---
name: pharos-invoice-to-payment
description: Validate text, structured JSON, or supported native EIP-681 invoices and prepare unsigned native PROS transfers on Pharos Pacific Mainnet.
---

# Pharos Invoice-to-Payment

Use this skill to inspect an invoice and prepare a native PROS payment payload. Preparation is not payment completion.

1. Provide the invoice as labeled text, supported JSON, or `ethereum:<recipient>@1672?value=<wei>&reference=<reference>`.
2. Resolve every reported missing field, conflict, mismatch, or unsupported value in the source invoice. Do not infer or repair invoice details.
3. Only native PROS on Pharos Pacific Mainnet (`native:1672`, chain ID `1672`) is supported. ERC-20 and fiat payments are blocked.
4. Review the recipient, exact amount, network, and reference before preparing. The reference is encoded in transaction data as UTF-8 `PHAROS-INVOICE/1:<reference>`.
5. Treat every result as `PREPARED_UNSIGNED` and `broadcast: false`. Live account verification, wallet gas estimation, signing, broadcasting, and payment-status checks are outside this agent.
