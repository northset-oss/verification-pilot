const RETIRED_MESSAGE =
  'PR receipt disclosure is retired; upstream inspection, copy generation, and mutation are disabled';

function retired() {
  throw new Error(RETIRED_MESSAGE);
}

export function validateDisclosurePolicy() {
  return retired();
}

export function canonicalReceiptUrl() {
  return retired();
}

export function renderDisclosureBlock() {
  return retired();
}

export function upsertDisclosureBlock() {
  return retired();
}

export function createFetchRequest() {
  return retired();
}

export async function auditAllDisclosures() {
  return retired();
}

export async function auditAllFactoryDisclosures() {
  return retired();
}

export async function syncFactoryDisclosure() {
  return retired();
}

export async function syncMissionDisclosure() {
  return retired();
}

export const PR_RECEIPT_DISCLOSURE_RETIRED = RETIRED_MESSAGE;
