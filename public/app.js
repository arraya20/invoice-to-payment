const REVIEW_CONFIRMATION =
  "I reviewed the recipient, amount, asset, network, and reference.";

export const SAMPLE_INVOICES = Object.freeze({
  text: `Invoice Reference: PH-2026-1001
Payee: 0x1111111111111111111111111111111111111111
Amount: 0.0001
Asset: native:1672
Currency: PROS
Network: Pharos Pacific Mainnet
Chain ID: 1672
Description: Sample infrastructure invoice`,
  json: JSON.stringify({
    invoiceReference: "PH-2026-1002",
    payment: {
      payee: "0x1111111111111111111111111111111111111111",
      amount: "0.0002",
      assetId: "native:1672",
      tokenLabel: "PROS",
      chainId: 1672
    },
    networkName: "Pharos Pacific Mainnet",
    description: "Structured sample invoice"
  }, null, 2),
  missing: `Invoice Reference: PH-2026-MISSING
Amount: 0.0001
Asset: native:1672
Currency: PROS
Network: Pharos Pacific Mainnet
Chain ID: 1672`
});

export async function submitInvoice(
  invoice,
  reviewed,
  fetcher = globalThis.fetch,
  expectedPayment
) {
  if (!reviewed) {
    return {
      ok: false,
      error: "Review the recipient, amount, asset, network, and reference first."
    };
  }

  try {
    const requestBody = { invoice, reviewConfirmation: REVIEW_CONFIRMATION };
    if (expectedPayment) requestBody.expectedPayment = expectedPayment;

    const response = await fetcher("/api/invoice", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody)
    });
    const data = await response.json();

    if (!response.ok || !data?.ok) {
      return {
        ok: false,
        error: data?.error ?? "Invoice preparation failed.",
        issues: data?.issues ?? []
      };
    }

    const prepared = data.prepared;
    if (
      prepared?.status !== "PREPARED_UNSIGNED"
      || prepared.unsigned !== true
      || prepared.broadcast !== false
      || !prepared.preparedTx
    ) {
      return { ok: false, error: "The API response did not contain a valid unsigned transaction." };
    }
    return { ok: true, prepared, provenance: data.provenance ?? {} };
  } catch {
    return { ok: false, error: "The invoice service is unavailable. No transaction was prepared." };
  }
}

function renderResult(output, result) {
  if (result.ok) {
    output.textContent = JSON.stringify({
      provenance: result.provenance,
      prepared: result.prepared
    }, null, 2);
    return;
  }
  output.textContent = JSON.stringify({
    status: "BLOCKED",
    error: result.error,
    issues: result.issues ?? []
  }, null, 2);
}

function bindDashboard() {
  const form = document.getElementById("invoice-form");
  if (!form) return;

  const input = document.getElementById("invoice-text");
  const expectedInput = document.getElementById("expected-payment");
  const sample = document.getElementById("sample-invoice");
  const review = document.getElementById("review-confirmed");
  const submit = document.getElementById("prepare-button");
  const output = document.getElementById("output");
  let requestVersion = 0;

  const invalidateReview = () => {
    requestVersion += 1;
    review.checked = false;
    submit.disabled = true;
    output.textContent = "Invoice changed. Review it again before preparing.";
  };

  sample.addEventListener("change", () => {
    input.value = SAMPLE_INVOICES[sample.value] ?? SAMPLE_INVOICES.text;
    invalidateReview();
  });

  input.addEventListener("input", invalidateReview);
  expectedInput.addEventListener("input", invalidateReview);

  review.addEventListener("change", () => {
    submit.disabled = !review.checked;
    if (!review.checked) {
      requestVersion += 1;
      output.textContent = "Review confirmation removed. No transaction was prepared.";
    }
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const requestVersionAtSubmit = requestVersion;
    submit.disabled = true;
    output.textContent = "Validating invoice and preparing an unsigned transaction…";
    let expectedPayment;
    if (expectedInput.value.trim()) {
      try {
        expectedPayment = JSON.parse(expectedInput.value);
        if (!expectedPayment || typeof expectedPayment !== "object" || Array.isArray(expectedPayment)) {
          throw new Error("Expected payment must be a JSON object.");
        }
      } catch {
        renderResult(output, {
          ok: false,
          error: "Expected payment must be a valid JSON object."
        });
        submit.disabled = !review.checked;
        return;
      }
    }
    const result = await submitInvoice(input.value, review.checked, globalThis.fetch, expectedPayment);
    if (requestVersionAtSubmit !== requestVersion) return;
    renderResult(output, result);
    submit.disabled = !review.checked;
  });
}

if (typeof document !== "undefined") {
  document.addEventListener("DOMContentLoaded", bindDashboard);
}
