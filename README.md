# Pharos Invoice-to-Payment Agent

A preparation-only invoice checker for native PROS transfers on Pharos Pacific Mainnet. It extracts invoice fields, reports missing or conflicting values, optionally compares them with independently supplied expected details, and returns a transaction payload that is **unsigned and not broadcast**.

## Supported inputs and route

- Labeled plain text.
- Structured JSON with documented common property names.
- Native EIP-681 transfers in the form `ethereum:<recipient>@1672?value=<wei>&reference=<invoice-reference>`. `value` is interpreted as wei, not whole PROS. A reference is required.

Every payment must explicitly provide an invoice reference, recipient, amount, asset (`native:1672`), token (`PROS`), network, and chain ID (`1672`). Missing or conflicting values block preparation. JSON amounts must be decimal strings; JSON numbers are rejected to avoid precision loss. Decimal conversion uses `BigInt`.

Only native PROS on Pharos Pacific Mainnet is supported. ERC-20, fiat, and other chains are rejected because there is no verified token contract and reference-bearing ERC-20 route configured. The invoice reference is encoded as UTF-8 `PHAROS-INVOICE/1:<reference>` in the unsigned transaction's `data` and is also shown in the payment summary. Let the wallet estimate gas, then review the summary and raw transaction fields before signing.

This project performs local invoice validation; it does not verify the recipient's live on-chain account type. It does not connect to a wallet, sign, broadcast, or check payment completion. Sample recipients are demonstrations only; never sign or broadcast sample transactions. PDF/OCR extraction is not implemented. Do not treat preparation as proof of payment.

## Run locally

```bash
npm install
npm test
npm run check
npm run dev
```

Open <http://localhost:8788>. The form includes valid text and JSON samples and a missing-payee example. All sample recipients are demonstrations only and must not be signed or broadcast. The API requires the exact human confirmation shown by the page. Editing either the invoice or expected-payment details clears that confirmation.

## Deploy to Cloudflare Pages

The repository is configured as a Cloudflare Pages project: static files are in `public/`, and the `/api/invoice` Function is in `functions/`.

1. Authenticate with `npx wrangler login`.
2. Create the Pages project once: `npx wrangler pages project create invoice-to-payment-agent --production-branch main`.
3. Deploy with `npm run deploy`.

The repository URL and a deployed demo URL are separate from the Pharos Agent Arena task page. To submit, use the task page at <https://pharos-agent-arena.vercel.app/tasks/invoice-to-payment-agent>; reviewers request a working proof link and the repository link. Deployment and task-board submission both require the account owner's credentials and are not performed by local tests.

## API

`POST /api/invoice` accepts JSON:

```json
{
  "invoice": "Invoice Reference: PH-2026-1001\nPayee: 0x1111111111111111111111111111111111111111\nAmount: 0.0001\nAsset: native:1672\nCurrency: PROS\nNetwork: Pharos Pacific Mainnet\nChain ID: 1672",
  "reviewConfirmation": "I reviewed the recipient, amount, asset, network, and reference.",
  "expectedPayment": {
    "amount": "0.0001",
    "recipient": "0x1111111111111111111111111111111111111111"
  }
}
```

`expectedPayment` is optional and its values are compared to the invoice without silently changing it. Invalid requests return JSON errors; invoice issues return `422`, and missing review confirmation returns `428`. The endpoint accepts only JSON POST requests, applies a 40 KiB request limit, and does not enable cross-origin access.
