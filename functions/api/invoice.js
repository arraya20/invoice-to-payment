import { handleInvoiceRequest } from "../../src/endpoint.mjs";

export async function onRequest({ request }) {
  try {
    return await handleInvoiceRequest(request);
  } catch (error) {
    console.error("Invoice endpoint failed:", error instanceof Error ? error.message : "unknown error");
    return new Response(JSON.stringify({ ok: false, error: "Invoice preparation failed unexpectedly." }), {
      status: 500,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "application/json; charset=utf-8"
      }
    });
  }
}
