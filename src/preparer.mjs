import { InvoiceParser } from "./parser.mjs";

const REFERENCE_PREFIX = "PHAROS-INVOICE/1:";
const encoder = new TextEncoder();

function encodeReference(invoiceId) {
  const bytes = encoder.encode(`${REFERENCE_PREFIX}${invoiceId}`);
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export class PaymentTransactionPreparer {
  static prepare(rawInvoice, expectedPayment) {
    const invoice = InvoiceParser.parse(rawInvoice, expectedPayment);
    const reference = `${REFERENCE_PREFIX}${invoice.invoiceId}`;

    return {
      status: "PREPARED_UNSIGNED",
      unsigned: true,
      broadcast: false,
      invoice,
      summary: {
        invoiceId: invoice.invoiceId,
        recipient: invoice.recipient,
        amount: invoice.amount,
        amountRaw: invoice.amountRaw,
        token: invoice.token,
        assetId: invoice.assetId,
        network: invoice.network,
        chainId: invoice.chainId
      },
      reference: invoice.invoiceId,
      preparedTx: {
        chainId: invoice.chainId,
        to: invoice.recipient,
        value: `0x${BigInt(invoice.amountRaw).toString(16)}`,
        data: encodeReference(invoice.invoiceId)
      },
      memo: reference,
      signingNotice: "Unsigned only. Verify the recipient, amount, network, and reference in your wallet before signing. Gas must be estimated by the wallet.",
      createdAt: new Date().toISOString()
    };
  }
}
