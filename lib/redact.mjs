const EMAIL_PATTERN = /\b[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+\b/gi;

function count(redactions, kind) {
  redactions[kind] = (redactions[kind] ?? 0) + 1;
  return `[REDACTED:${kind}]`;
}

function replaceMatches(value, pattern, kind, redactions) {
  return value.replace(pattern, () => count(redactions, kind));
}

function redactLine(line, redactions) {
  let redacted = line;

  // Contextual forms run before generic token patterns so one secret is counted once.
  redacted = redacted.replace(
    /^(\s*(?:export\s+)?[A-Z_][A-Z0-9_]*(?:TOKEN|SECRET|KEY|PASSWORD|PASSPHRASE|CREDENTIAL)[A-Z0-9_]*\s*=\s*).*$/i,
    (_match, prefix) => `${prefix}${count(redactions, 'env')}`,
  );
  redacted = redacted.replace(
    /(\bAuthorization\s*:\s*)[^\r\n]+/gi,
    (_match, prefix) => `${prefix}${count(redactions, 'authorization')}`,
  );
  redacted = redacted.replace(
    /\bBearer\s+[^\s,;]+/gi,
    () => `Bearer ${count(redactions, 'bearer')}`,
  );
  redacted = redacted.replace(
    /([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi,
    (_match, scheme) => `${scheme}${count(redactions, 'url_userinfo')}@`,
  );
  redacted = redacted.replace(
    /([?&](?:token|key|secret|password)=)([^&#\s]*)/gi,
    (_match, prefix) => `${prefix}${count(redactions, 'url_query')}`,
  );

  redacted = replaceMatches(
    redacted,
    /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
    'github_token',
    redactions,
  );
  redacted = replaceMatches(
    redacted,
    /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?![A-Za-z0-9_-])/g,
    'jwt',
    redactions,
  );
  redacted = replaceMatches(
    redacted,
    /(?<![A-Z0-9])AKIA[0-9A-Z]{16}(?![A-Z0-9])/g,
    'aws_access_key',
    redactions,
  );
  redacted = replaceMatches(
    redacted,
    /(?<![A-Fa-f0-9])0x[A-Fa-f0-9]{64}(?![A-Fa-f0-9])/g,
    'hex_private_key',
    redactions,
  );
  redacted = redacted.replace(EMAIL_PATTERN, (email) => {
    if (email.toLowerCase().endsWith('@northset.ai')) return email;
    return count(redactions, 'email');
  });
  redacted = redacted.replace(
    /\/(Users|home)\/[^/\s]+\//g,
    (_match, root) => {
      count(redactions, 'path');
      return `/${root}/[user]/`;
    },
  );

  return redacted;
}

/**
 * Redact sensitive values from text while preserving its original line endings.
 * The optional redactions object is updated in place with replacement counts.
 *
 * @param {string} value
 * @param {Record<string, number>} [redactions]
 * @returns {string}
 */
export function redactText(value, redactions = {}) {
  if (typeof value !== 'string') {
    throw new TypeError('redactText value must be a string');
  }

  let redacted = value.replace(
    /-----BEGIN ([A-Z ]*PRIVATE KEY)-----[\s\S]*?-----END \1-----/g,
    () => count(redactions, 'private_key'),
  );

  redacted = redacted
    .split(/(\r?\n)/)
    .map((part, index) => (index % 2 === 0 ? redactLine(part, redactions) : part))
    .join('');

  return redacted;
}

/**
 * Return a deep copy with redaction applied to every string value.
 *
 * @param {unknown} value
 * @param {Record<string, number>} [redactions]
 * @returns {unknown}
 */
export function redactJsonStrings(value, redactions = {}) {
  if (typeof value === 'string') return redactText(value, redactions);
  if (Array.isArray(value)) {
    return value.map((item) => redactJsonStrings(item, redactions));
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactJsonStrings(item, redactions)]),
    );
  }
  return value;
}

/**
 * Return counts with stable key ordering for deterministic JSON output.
 *
 * @param {Record<string, number>} redactions
 * @returns {Record<string, number>}
 */
export function sortRedactions(redactions) {
  return Object.fromEntries(Object.entries(redactions).sort(([left], [right]) => {
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
  }));
}
