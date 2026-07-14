const PUBLICATION_ENVELOPE_FIELDS = new Set(['attestation_uri', 'run_record_bundle_digest']);

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function receiptParityViolations(top, bundled) {
  const keys = new Set([...Object.keys(top), ...Object.keys(bundled)]);
  const violations = [];
  for (const key of keys) {
    if (PUBLICATION_ENVELOPE_FIELDS.has(key)) continue;
    if (stableStringify(top[key]) !== stableStringify(bundled[key])) violations.push(key);
  }
  for (const key of PUBLICATION_ENVELOPE_FIELDS) {
    if (bundled[key] !== null && bundled[key] !== undefined && bundled[key] !== top[key]) {
      violations.push(`${key} (bundle value diverges)`);
    }
  }
  return violations;
}

export function assertReceiptParity(top, bundled, label = 'signed bundle') {
  const violations = receiptParityViolations(top, bundled);
  if (violations.length > 0) {
    throw new TypeError(`${label} mission diverges from the public receipt in: ${violations.join(', ')}`);
  }
}
