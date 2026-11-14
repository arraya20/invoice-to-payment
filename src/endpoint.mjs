import { InvoiceParser } from "./parser.mjs";
import { PaymentTransactionPreparer } from "./preparer.mjs";

export const REVIEW_CONFIRMATION =
  "I reviewed the recipient, amount, asset, network, and reference.";

const MAX_REQUEST_BYTES = 40 * 1024;

function reply(status, body, headers = {}) {
  return {
    status,
    body,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      ...headers
    }
  };
}

export function prepareInvoicePayload(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return reply(400, { ok: false, error: "Request body must be a JSON object." });
  }
  if (body.invoice === undefined || body.invoice === null || body.invoice === "") {
    return reply(400, { ok: false, error: "Invoice input is required." });
  }
  if (body.reviewConfirmation !== REVIEW_CONFIRMATION) {
    return reply(428, {
      ok: false,
      error: "Review the recipient, amount, asset, network, and reference before preparing."
    });
  }

  const analysis = InvoiceParser.analyze(body.invoice, body.expectedPayment);
  if (analysis.status !== "READY") {
    return reply(422, {
      ok: false,
      status: analysis.status,
      error: "Invoice validation failed; no transaction was prepared.",
      invoice: analysis.invoice,
      provenance: analysis.provenance,
      issues: analysis.issues
    });
  }

  const prepared = PaymentTransactionPreparer.prepare(body.invoice, body.expectedPayment);
  return reply(200, { ok: true, prepared, provenance: analysis.provenance });
}

async function readRequestBody(request) {
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    return { error: "Request body exceeds the 40 KiB limit.", status: 413 };
  }
  if (!request.body) return { error: "Request body is required.", status: 400 };

  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_REQUEST_BYTES) {
        await reader.cancel();
        return { error: "Request body exceeds the 40 KiB limit.", status: 413 };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { body: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) };
  } catch {
    return { error: "Request body must contain valid JSON.", status: 400 };
  }
}

export async function handleInvoiceRequest(request) {
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ ok: false, error: "Method not allowed." }), {
      status: 405,
      headers: {
        Allow: "POST",
        "Cache-Control": "no-store",
        "Content-Type": "application/json; charset=utf-8"
      }
    });
  }
  const contentType = request.headers.get("content-type")
    ?.split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (contentType !== "application/json") {
    return new Response(JSON.stringify({ ok: false, error: "Content-Type must be application/json." }), {
      status: 415,
      headers: { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" }
    });
  }

  const parsed = await readRequestBody(request);
  const result = parsed.error
    ? reply(parsed.status, { ok: false, error: parsed.error })
    : prepareInvoicePayload(parsed.body);
  return new Response(JSON.stringify(result.body), { status: result.status, headers: result.headers });
}
