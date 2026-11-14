import { test, run, assert, equal, throws } from "./harness.mjs";
import { InvoiceParser } from "../src/parser.mjs";
import { PaymentTransactionPreparer } from "../src/preparer.mjs";
import { REVIEW_CONFIRMATION, prepareInvoicePayload } from "../src/endpoint.mjs";
import { onRequest } from "../functions/api/invoice.js";
import { SAMPLE_INVOICES, submitInvoice } from "../public/app.js";

const recipient = "0x1111111111111111111111111111111111111111";
const textInvoice = (overrides = {}) =>
  Object.entries({
    "Invoice Reference": "PH-2026-1001",
    Payee: recipient,
    Amount: "0.0001",
    Asset: "native:1672",
    Currency: "PROS",
    Network: "Pharos Pacific Mainnet",
    "Chain ID": "1672",
    ...overrides
  })
    .map(([label, value]) => `${label}: ${value}`)
    .join("\n");

const jsonInvoice = (overrides = {}) => ({
  invoiceReference: "PH-2026-1002",
  payment: {
    payee: recipient,
    amount: "0.0002",
    assetId: "native:1672",
    tokenLabel: "PROS",
    chainId: 1672
  },
  networkName: "Pharos Pacific Mainnet",
  ...overrides
});

const tests = [
  test("InvoiceParser extracts labeled text with exact amount and provenance", () => {
    const result = InvoiceParser.analyze(textInvoice());
    equal(result.status, "READY");
    equal(result.format, "text");
    equal(result.invoice.invoiceId, "PH-2026-1001");
    equal(result.invoice.amountRaw, "100000000000000");
    equal(result.provenance.recipient.source.kind, "text");
  }),

  test("InvoiceParser extracts supported structured JSON fields", () => {
    const result = InvoiceParser.analyze(jsonInvoice());
    equal(result.status, "READY");
    equal(result.format, "json");
    equal(result.invoice.amount, "0.0002");
    equal(result.invoice.chainId, 1672);
    equal(result.provenance.amount.source.path, "payment.amount");
  }),

  test("InvoiceParser extracts fields from a natural-language request without approving unsupported details", () => {
    const result = InvoiceParser.analyze(
      `Invoice #402: Send 250 USDC to ${recipient} for audit`
    );
    equal(result.invoice.invoiceId, "402");
    equal(result.invoice.recipient, recipient);
    equal(result.invoice.amount, "250");
    equal(result.invoice.token, "USDC");
    equal(result.status, "BLOCKED");
  }),

  test("InvoiceParser blocks missing and conflicting invoice fields", () => {
    const missing = InvoiceParser.analyze("Invoice Reference: PH-1\nAmount: 1");
    assert(missing.issues.some((issue) => issue.code === "MISSING_RECIPIENT"));

    const conflict = InvoiceParser.analyze(
      textInvoice({ "Total Amount": "0.0003" })
    );
    const conflictIssue = conflict.issues.find((issue) => issue.code === "CONFLICT_AMOUNT");
    equal(conflictIssue.values.length, 2);
    equal(conflict.status, "BLOCKED");
  }),

  test("InvoiceParser compares expected amounts exactly and rejects numeric expectations", () => {
    const equivalent = InvoiceParser.analyze(textInvoice(), { amount: "0.00010" });
    equal(equivalent.status, "READY");

    const rounded = InvoiceParser.analyze(textInvoice(), { amount: 0.0001 });
    equal(rounded.status, "BLOCKED");
    assert(rounded.issues.some((issue) => issue.code === "INVALID_EXPECTED_AMOUNT"));

    const mismatch = InvoiceParser.analyze(textInvoice(), { amount: "0.0002" });
    const mismatchIssue = mismatch.issues.find((issue) => issue.code === "MISMATCH_AMOUNT");
    equal(mismatchIssue.invoiceValue, "0.0001");
    equal(mismatchIssue.expectedValue, "0.0002");

    const invalid = InvoiceParser.analyze(textInvoice(), []);
    assert(invalid.issues.some((issue) => issue.code === "INVALID_EXPECTED_PAYMENT"));
  }),

  test("InvoiceParser blocks invalid or unsupported payment routes", () => {
    for (const [overrides, code] of [
      [{ "Invoice Reference": "" }, "MISSING_INVOICEID"],
      [{ Payee: "" }, "MISSING_RECIPIENT"],
      [{ Payee: "not-an-address" }, "INVALID_RECIPIENT"],
      [{ Payee: `0x${"0".repeat(40)}` }, "ZERO_RECIPIENT"],
      [{ Amount: "-1" }, "INVALID_AMOUNT"],
      [{ Amount: "1e3" }, "INVALID_AMOUNT"],
      [{ Amount: "0" }, "INVALID_AMOUNT"],
      [{ Currency: "USDC", Asset: "token:usdc" }, "UNSUPPORTED_ASSET"],
      [{ "Chain ID": "50002" }, "WRONG_CHAIN"]
    ]) {
      const result = InvoiceParser.analyze(textInvoice(overrides));
      equal(result.status, "BLOCKED");
      assert(result.issues.some((issue) => issue.code === code), code);
    }
  }),

  test("InvoiceParser rejects rounded numeric JSON amounts and malformed JSON", () => {
    const numeric = InvoiceParser.analyze(
      jsonInvoice({ payment: { ...jsonInvoice().payment, amount: 0.0002 } })
    );
    assert(numeric.issues.some((issue) => issue.code === "INVALID_AMOUNT_TYPE"));

    const malformed = InvoiceParser.analyze("{");
    assert(malformed.issues.some((issue) => issue.code === "INVALID_JSON"));
  }),

  test("InvoiceParser reads native EIP-681 values as base units and preserves reference", () => {
    const result = InvoiceParser.analyze(
      `ethereum:${recipient}@1672?value=100000000000000&reference=PH-2026-URI`
    );
    equal(result.status, "READY");
    equal(result.invoice.amount, "0.0001");
    equal(result.invoice.amountRaw, "100000000000000");
    equal(result.invoice.invoiceId, "PH-2026-URI");
  }),

  test("InvoiceParser blocks payment URIs that omit the invoice reference", () => {
    const result = InvoiceParser.analyze(`ethereum:${recipient}@1672?value=100000000000000`);
    equal(result.status, "BLOCKED");
    assert(result.issues.some((issue) => issue.code === "MISSING_INVOICEID"));
  }),

  test("PaymentTransactionPreparer includes exact amount and invoice reference", () => {
    const prepared = PaymentTransactionPreparer.prepare(textInvoice());
    equal(prepared.status, "PREPARED_UNSIGNED");
    equal(prepared.unsigned, true);
    equal(prepared.broadcast, false);
    equal(prepared.preparedTx.chainId, 1672);
    equal(prepared.preparedTx.to, recipient);
    equal(prepared.preparedTx.value, "0x5af3107a4000");
    const expectedData = `0x${Array.from(
      new TextEncoder().encode("PHAROS-INVOICE/1:PH-2026-1001"),
      (byte) => byte.toString(16).padStart(2, "0")
    ).join("")}`;
    equal(prepared.preparedTx.data, expectedData);
    equal(prepared.reference, "PH-2026-1001");
    equal(prepared.summary.amountRaw, "100000000000000");
  }),

  test("PaymentTransactionPreparer refuses blocked invoices", () => {
    throws(
      () => PaymentTransactionPreparer.prepare(textInvoice({ Currency: "USDC" })),
      "UNSUPPORTED_TOKEN"
    );
  }),

  test("API requires an explicit human review confirmation", () => {
    const response = prepareInvoicePayload({ invoice: textInvoice() });
    equal(response.status, 428);
    equal(response.body.ok, false);
  }),

  test("API blocks invoice mismatches without returning a transaction", () => {
    const response = prepareInvoicePayload({
      invoice: textInvoice(),
      expectedPayment: { amount: "1" },
      reviewConfirmation: REVIEW_CONFIRMATION
    });
    equal(response.status, 422);
    equal(response.body.ok, false);
    assert(response.body.issues.some((issue) => issue.code === "MISMATCH_AMOUNT"));
    equal(response.body.prepared, undefined);
  }),

  test("API rejects malformed expected-payment field types without throwing", () => {
    const response = prepareInvoicePayload({
      invoice: textInvoice(),
      expectedPayment: { recipient: { toString: 1 } },
      reviewConfirmation: REVIEW_CONFIRMATION
    });
    equal(response.status, 422);
    assert(response.body.issues.some((issue) => issue.code === "INVALID_EXPECTED_RECIPIENT"));
  }),

  test("API prepares only confirmed, valid invoices", () => {
    const response = prepareInvoicePayload({
      invoice: jsonInvoice(),
      reviewConfirmation: REVIEW_CONFIRMATION
    });
    equal(response.status, 200);
    equal(response.body.ok, true);
    equal(response.body.prepared.broadcast, false);
    equal(response.body.prepared.summary.invoiceId, "PH-2026-1002");
    equal(response.body.provenance.recipient.source.path, "payment.payee");
  }),

  test("Pages API rejects non-POST requests with the correct method", async () => {
    const response = await onRequest({
      request: new Request("https://example.test/api/invoice", { method: "GET" })
    });
    equal(response.status, 405);
    equal(response.headers.get("allow"), "POST");
  }),

  test("Pages API rejects JSON-like but invalid media types", async () => {
    const response = await onRequest({
      request: new Request("https://example.test/api/invoice", {
        method: "POST",
        headers: { "content-type": "application/jsonp" },
        body: "{}"
      })
    });
    equal(response.status, 415);
  }),

  test("Pages API limits request bodies and rejects malformed JSON", async () => {
    const oversized = await onRequest({
      request: new Request("https://example.test/api/invoice", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ invoice: "x".repeat(41 * 1024) })
      })
    });
    equal(oversized.status, 413);

    const malformed = await onRequest({
      request: new Request("https://example.test/api/invoice", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{"
      })
    });
    equal(malformed.status, 400);
  }),

  test("Pages API returns JSON validation errors without exposing exceptions", async () => {
    const response = await onRequest({
      request: new Request("https://example.test/api/invoice", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ invoice: "missing fields", reviewConfirmation: REVIEW_CONFIRMATION })
      })
    });
    const body = await response.json();
    equal(response.status, 422);
    equal(body.ok, false);
    assert(body.issues.some((issue) => issue.code === "MISSING_RECIPIENT"));
  }),

  test("UI does not call the API until human review is confirmed", async () => {
    let calls = 0;
    const result = await submitInvoice(textInvoice(), false, async () => {
      calls += 1;
    });
    equal(result.ok, false);
    equal(calls, 0);
  }),

  test("UI shows network errors instead of fabricating a prepared payment", async () => {
    const result = await submitInvoice(textInvoice(), true, async () => {
      throw new Error("offline");
    });
    equal(result.ok, false);
    equal(result.prepared, undefined);
    assert(result.error.includes("No transaction was prepared"));
  }),

  test("UI sends independently supplied expected payment details for reconciliation", async () => {
    let requestBody;
    await submitInvoice(
      textInvoice(),
      true,
      async (_url, options) => {
        requestBody = JSON.parse(options.body);
        return {
          ok: false,
          json: async () => ({ ok: false, error: "Mismatch", issues: [] })
        };
      },
      { amount: "0.5" }
    );
    equal(requestBody.expectedPayment.amount, "0.5");
    equal(requestBody.reviewConfirmation, REVIEW_CONFIRMATION);
  }),

  test("UI preserves field provenance alongside a valid unsigned transaction", async () => {
    const prepared = {
      status: "PREPARED_UNSIGNED",
      unsigned: true,
      broadcast: false,
      preparedTx: { chainId: 1672, to: recipient, value: "0x1", data: "0x" }
    };
    const provenance = { recipient: { source: { kind: "text", excerpt: "Payee: ..." } } };
    const result = await submitInvoice(textInvoice(), true, async () => ({
      ok: true,
      json: async () => ({ ok: true, prepared, provenance })
    }));
    equal(result.ok, true);
    equal(result.provenance.recipient.source.kind, "text");
  }),

  test("UI sample invoices include valid text and structured examples", () => {
    equal(InvoiceParser.analyze(SAMPLE_INVOICES.text).status, "READY");
    equal(InvoiceParser.analyze(SAMPLE_INVOICES.json).status, "READY");
    equal(InvoiceParser.analyze(SAMPLE_INVOICES.missing).status, "BLOCKED");
  })
];

run(tests);
