const NETWORK = Object.freeze({
  name: "Pharos Pacific Mainnet",
  aliases: ["pharos pacific mainnet", "pharos pacific", "pacific mainnet"],
  chainId: 1672,
  token: "PROS",
  assetId: "native:1672",
  decimals: 18
});

const INPUT_LIMIT_BYTES = 32 * 1024;
const REFERENCE_LIMIT_BYTES = 64;
const addressPattern = /^0x[0-9a-fA-F]{40}$/;
const zeroAddressPattern = /^0x0{40}$/i;
const encoder = new TextEncoder();

const fieldAliases = {
  invoiceId: ["invoice reference", "invoice ref", "reference", "invoice id", "invoice number"],
  recipient: ["payee", "recipient", "payee address", "recipient address", "payable to"],
  amount: ["amount", "total", "amount due", "total amount"],
  assetId: ["asset", "asset id", "payment asset"],
  token: ["currency", "token", "token label"],
  chainId: ["chain id", "chainid"],
  network: ["network", "payment network"],
  description: ["description", "service", "memo"]
};

const jsonPaths = {
  invoiceId: ["invoiceId", "invoiceReference", "reference", "invoice.reference"],
  recipient: ["recipient", "payee", "recipientAddress", "payeeAddress", "payment.recipient", "payment.payee"],
  amount: ["amount", "total", "payment.amount"],
  assetId: ["assetId", "asset", "payment.assetId", "payment.asset"],
  token: ["token", "currency", "tokenLabel", "payment.token", "payment.currency", "payment.tokenLabel"],
  chainId: ["chainId", "network.chainId", "payment.chainId"],
  network: ["network", "networkName", "network.name", "payment.network"],
  description: ["description", "service", "payment.description"]
};

function issue(code, field, message, details = {}) {
  return { code, field, message, ...details };
}

function blocked(format, issues, invoice = {}) {
  return { status: "BLOCKED", format, invoice, provenance: {}, issues };
}

function addField(found, name, value, source, original = value) {
  (found[name] ??= []).push({
    value: String(value).trim(),
    original,
    source
  });
}

function collectText(input) {
  const found = {};
  let offset = 0;

  for (const line of input.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon > 0) {
      const label = line.slice(0, colon).trim().toLowerCase();
      const value = line.slice(colon + 1).trim();
      for (const [name, aliases] of Object.entries(fieldAliases)) {
        if (!aliases.includes(label)) continue;
        const amountAndToken = name === "amount"
          ? value.match(/^([0-9]+(?:\.[0-9]+)?)(?:\s+([A-Za-z][A-Za-z0-9._-]*))?$/)
          : null;
        addField(
          found,
          name,
          amountAndToken?.[1] ?? value,
          { kind: "text", excerpt: line.trim(), start: offset, end: offset + line.length },
          value
        );
        if (amountAndToken?.[2]) {
          addField(
            found,
            "token",
            amountAndToken[2],
            { kind: "text", excerpt: line.trim(), start: offset, end: offset + line.length },
            amountAndToken[2]
          );
        }
        break;
      }
    }

    const invoiceMatch = line.match(/\binvoice\s*#\s*([A-Za-z0-9._/-]+)/i);
    if (invoiceMatch) {
      addField(
        found,
        "invoiceId",
        invoiceMatch[1],
        { kind: "text", excerpt: line.trim(), start: offset, end: offset + line.length }
      );
    }

    const naturalRecipient = line.match(/\b(?:to|payable to)\s+(0x[0-9a-fA-F]{40})\b/i);
    if (naturalRecipient) {
      addField(
        found,
        "recipient",
        naturalRecipient[1],
        { kind: "text", excerpt: line.trim(), start: offset, end: offset + line.length }
      );
    }

    const naturalAmount = line.match(/\b([0-9]+(?:\.[0-9]+)?)\s*(PROS|USDC|USDT|WETH|DAI)\b/i);
    if (naturalAmount) {
      addField(
        found,
        "amount",
        naturalAmount[1],
        { kind: "text", excerpt: line.trim(), start: offset, end: offset + line.length }
      );
      addField(
        found,
        "token",
        naturalAmount[2],
        { kind: "text", excerpt: line.trim(), start: offset, end: offset + line.length }
      );
    }

    offset += line.length + 1;
  }

  return found;
}

function atPath(object, path) {
  let current = object;
  for (const part of path.split(".")) {
    if (!current || typeof current !== "object" || !(part in current)) return undefined;
    current = current[part];
  }
  return current;
}

function collectJson(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { found: {}, issues: [issue("INVALID_JSON", "invoice", "Invoice JSON must be an object.")] };
  }

  const found = {};
  for (const [name, paths] of Object.entries(jsonPaths)) {
    for (const path of paths) {
      const value = atPath(input, path);
      if (value === undefined || value === null) continue;
      if (typeof value !== "string" && typeof value !== "number") continue;
      addField(
        found,
        name,
        value,
        {
          kind: "json",
          path,
          ...(name === "amount" && typeof value !== "string" ? { invalidType: typeof value } : {})
        },
        value
      );
    }
  }
  return { found, issues: [] };
}

function formatNativeUnits(value) {
  const raw = BigInt(value);
  const scale = 10n ** BigInt(NETWORK.decimals);
  const whole = (raw / scale).toString();
  const fraction = (raw % scale).toString().padStart(NETWORK.decimals, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

function collectPaymentUri(input) {
  const match = input.match(/^ethereum:(0x[0-9a-fA-F]{40})@(\d+)\?(.+)$/i);
  if (!match) {
    return {
      found: {},
      issues: [issue(
        "UNSUPPORTED_FORMAT",
        "invoice",
        "Only native EIP-681 transfers with an explicit chain ID and invoice reference are supported."
      )]
    };
  }

  const [, recipient, chainId, query] = match;
  const parameters = new URLSearchParams(query);
  const found = {};
  const source = { kind: "uri", excerpt: input };
  addField(found, "recipient", recipient, source);
  addField(found, "chainId", chainId, source);
  if (chainId === String(NETWORK.chainId)) {
    addField(found, "network", NETWORK.name, source);
    addField(found, "assetId", NETWORK.assetId, source);
  }

  for (const key of ["reference", "ref", "invoiceId"]) {
    for (const value of parameters.getAll(key)) {
      addField(found, "invoiceId", value, { ...source, path: `?${key}` });
    }
  }

  const values = parameters.getAll("value");
  for (const value of values) {
    if (!/^\d+$/.test(value) || value.length > 78) {
      addField(found, "amount", value, { ...source, path: "?value", invalidValue: true });
      continue;
    }
    try {
      addField(found, "amount", formatNativeUnits(value), { ...source, path: "?value" }, value);
    } catch {
      addField(found, "amount", value, { ...source, path: "?value", invalidValue: true });
    }
  }

  const uriTokens = parameters.getAll("token");
  if (uriTokens.length) {
    for (const token of uriTokens) addField(found, "token", token, { ...source, path: "?token" });
  } else {
    addField(found, "token", NETWORK.token, source);
  }
  return { found, issues: [] };
}

function choose(found, name, issues, required = true) {
  const values = (found[name] ?? []).filter(({ value }) => value !== "");
  const distinct = [...new Set(values.map(({ value }) => value))];

  if (distinct.length > 1) {
    issues.push(issue(
      `CONFLICT_${name.toUpperCase()}`,
      name,
      `Conflicting ${name} values were found.`,
      { values: distinct }
    ));
    return null;
  }
  if (distinct.length === 0) {
    if (required) issues.push(issue(`MISSING_${name.toUpperCase()}`, name, `Required field ${name} is missing.`));
    return null;
  }

  return values[0];
}

function decimalToRaw(value) {
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) {
    throw new Error("Amount must be a positive plain decimal string.");
  }
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > NETWORK.decimals) {
    throw new Error(`Amount exceeds ${NETWORK.decimals} decimal places.`);
  }
  if (whole.length + fraction.length > 78) throw new Error("Amount is out of range.");
  const raw = BigInt(whole) * 10n ** BigInt(NETWORK.decimals)
    + BigInt((fraction + "0".repeat(NETWORK.decimals)).slice(0, NETWORK.decimals) || "0");
  if (raw <= 0n) throw new Error("Amount must be greater than zero.");
  if (raw.toString().length > 78) throw new Error("Amount is out of range.");
  return raw.toString();
}

function normalizeNetwork(value) {
  return value.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
}

function analyzeFields(format, found, initialIssues = [], expectedPayment) {
  const issues = [...initialIssues];
  const fields = {};
  for (const name of ["invoiceId", "recipient", "amount", "assetId", "token", "network", "chainId"]) {
    fields[name] = choose(found, name, issues);
  }
  fields.description = choose(found, "description", issues, false);

  let invoiceId = fields.invoiceId?.value ?? null;
  if (invoiceId && (
    encoder.encode(invoiceId).length > REFERENCE_LIMIT_BYTES
    || !/^[A-Za-z0-9._:/-]+$/.test(invoiceId)
  )) {
    issues.push(issue(
      "INVALID_REFERENCE",
      "invoiceId",
      "Invoice reference must be 1–64 bytes and use only letters, digits, dot, underscore, colon, slash, or hyphen."
    ));
  }

  let recipient = fields.recipient?.value ?? null;
  if (recipient && !addressPattern.test(recipient)) {
    issues.push(issue("INVALID_RECIPIENT", "recipient", "Payee must be a valid 20-byte EVM address."));
    recipient = null;
  } else if (recipient && zeroAddressPattern.test(recipient)) {
    issues.push(issue("ZERO_RECIPIENT", "recipient", "The zero address cannot be a payment recipient."));
    recipient = null;
  } else if (recipient) {
    recipient = recipient.toLowerCase();
  }

  let amountRaw = null;
  const amountField = fields.amount;
  if (amountField?.source.invalidType) {
    issues.push(issue(
      "INVALID_AMOUNT_TYPE",
      "amount",
      "JSON amounts must be decimal strings to avoid precision loss."
    ));
  } else if (amountField?.source.invalidValue) {
    issues.push(issue("INVALID_AMOUNT", "amount", "EIP-681 value must be an integer number of wei."));
  } else if (amountField) {
    try {
      amountRaw = decimalToRaw(amountField.value);
    } catch (error) {
      issues.push(issue("INVALID_AMOUNT", "amount", error.message));
    }
  }

  const chainText = fields.chainId?.value;
  const chainId = chainText && /^\d+$/.test(chainText) ? Number(chainText) : null;
  if (fields.chainId && chainId !== NETWORK.chainId) {
    issues.push(issue("WRONG_CHAIN", "chainId", `Only Pharos Pacific Mainnet (chain ${NETWORK.chainId}) is supported.`));
  }
  if (fields.chainId && chainId === null) {
    issues.push(issue("INVALID_CHAIN_ID", "chainId", "Chain ID must be an integer."));
  }

  const assetId = fields.assetId?.value ?? null;
  if (assetId && assetId.toLowerCase() !== NETWORK.assetId) {
    issues.push(issue("UNSUPPORTED_ASSET", "assetId", "Only native PROS on Pharos Pacific Mainnet is supported."));
  }

  const token = fields.token?.value?.toUpperCase() ?? null;
  if (token && token !== NETWORK.token) {
    issues.push(issue("UNSUPPORTED_TOKEN", "token", "Only native PROS payments are supported."));
  }

  const network = fields.network?.value ?? null;
  if (network && !NETWORK.aliases.includes(normalizeNetwork(network))) {
    issues.push(issue("WRONG_NETWORK", "network", "Only Pharos Pacific Mainnet is supported."));
  }

  const invoice = {
    invoiceId,
    recipient,
    amount: amountField?.value ?? null,
    amountRaw,
    assetId,
    token,
    chainId,
    network,
    description: fields.description?.value ?? null
  };

  if (expectedPayment !== undefined && expectedPayment !== null) {
    if (typeof expectedPayment !== "object" || Array.isArray(expectedPayment)) {
      issues.push(issue(
        "INVALID_EXPECTED_PAYMENT",
        "expectedPayment",
        "Expected payment details must be a JSON object."
      ));
    } else {
      const expectedFields = {
        invoiceId: expectedPayment.invoiceId ?? expectedPayment.reference,
        recipient: expectedPayment.recipient ?? expectedPayment.payee,
        assetId: expectedPayment.assetId,
        token: expectedPayment.token ?? expectedPayment.currency,
        chainId: expectedPayment.chainId,
        network: expectedPayment.network
      };
      if (expectedPayment.amount !== undefined && expectedPayment.amount !== null) {
        if (typeof expectedPayment.amount !== "string") {
          issues.push(issue(
            "INVALID_EXPECTED_AMOUNT",
            "amount",
            "Expected payment amounts must be decimal strings to avoid precision loss."
          ));
        } else {
          try {
            const expectedRaw = decimalToRaw(expectedPayment.amount.trim());
            if (amountRaw !== expectedRaw) {
              issues.push(issue(
                "MISMATCH_AMOUNT",
                "amount",
                "Invoice amount does not match the independently supplied expected value.",
                { invoiceValue: invoice.amount, expectedValue: expectedPayment.amount.trim() }
              ));
            }
          } catch {
            issues.push(issue("INVALID_EXPECTED_AMOUNT", "amount", "Expected payment amount is invalid."));
          }
        }
      }

      for (const [name, expected] of Object.entries(expectedFields)) {
        if (expected === undefined || expected === null) continue;
        const validType = name === "chainId"
          ? (typeof expected === "string" && /^\d+$/.test(expected))
            || (typeof expected === "number" && Number.isSafeInteger(expected))
          : typeof expected === "string";
        if (!validType) {
          issues.push(issue(
            `INVALID_EXPECTED_${name.toUpperCase()}`,
            name,
            `Expected payment ${name} has an invalid type.`
          ));
          continue;
        }
        if (name === "recipient" && (
          !addressPattern.test(expected) || zeroAddressPattern.test(expected)
        )) {
          issues.push(issue(
            "INVALID_EXPECTED_RECIPIENT",
            name,
            "Expected payment recipient must be a non-zero EVM address."
          ));
          continue;
        }
        const actual = invoice[name];
        let actualValue = String(actual ?? "").trim().toLowerCase();
        let expectedValue = String(expected).trim().toLowerCase();
        if (name === "token") {
          actualValue = actualValue.toUpperCase();
          expectedValue = expectedValue.toUpperCase();
        } else if (name === "network") {
          actualValue = normalizeNetwork(actualValue);
          expectedValue = normalizeNetwork(expectedValue);
        }
        if (actualValue !== expectedValue) {
          issues.push(issue(
            `MISMATCH_${name.toUpperCase()}`,
            name,
            `Invoice ${name} does not match the independently supplied expected value.`,
            { invoiceValue: actual, expectedValue: expected }
          ));
        }
      }
    }
  }

  const provenance = Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value).map(([name, value]) => [name, value])
  );
  return {
    status: issues.length ? "BLOCKED" : "READY",
    format,
    invoice,
    provenance,
    issues
  };
}

export class InvoiceParser {
  static analyze(rawInput, expectedPayment) {
    if (typeof rawInput === "string") {
      const input = rawInput.trim();
      if (!input) return blocked("text", [issue("MISSING_INPUT", "invoice", "Invoice input is required.")]);
      if (encoder.encode(input).length > INPUT_LIMIT_BYTES) {
        return blocked("text", [issue("INPUT_TOO_LARGE", "invoice", "Invoice input exceeds the 32 KiB limit.")]);
      }

      if (input.startsWith("{")) {
        let parsed;
        try {
          parsed = JSON.parse(input);
        } catch {
          return blocked("json", [issue("INVALID_JSON", "invoice", "Invoice input is not valid JSON.")]);
        }
        const collected = collectJson(parsed);
        return analyzeFields("json", collected.found, collected.issues, expectedPayment);
      }

      if (input.startsWith("ethereum:")) {
        const collected = collectPaymentUri(input);
        return analyzeFields("uri", collected.found, collected.issues, expectedPayment);
      }
      const found = collectText(input);
      return analyzeFields("text", found, [], expectedPayment);
    }

    if (rawInput && typeof rawInput === "object" && !Array.isArray(rawInput)) {
      let serialized;
      try {
        serialized = JSON.stringify(rawInput);
      } catch {
        return blocked("json", [issue("INVALID_JSON", "invoice", "Invoice object cannot be serialized safely.")]);
      }
      if (encoder.encode(serialized).length > INPUT_LIMIT_BYTES) {
        return blocked("json", [issue("INPUT_TOO_LARGE", "invoice", "Invoice input exceeds the 32 KiB limit.")]);
      }
      const collected = collectJson(rawInput);
      return analyzeFields("json", collected.found, collected.issues, expectedPayment);
    }

    return blocked("unknown", [issue("INVALID_INPUT", "invoice", "Invoice must be text or a JSON object.")]);
  }

  static parse(rawInput, expectedPayment) {
    const result = this.analyze(rawInput, expectedPayment);
    if (result.status !== "READY") {
      const error = new Error(result.issues.map(({ code }) => code).join(", "));
      error.issues = result.issues;
      throw error;
    }
    return result.invoice;
  }
}
