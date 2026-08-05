export const CONNECTOR_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function isValidConnectorId(value: unknown): value is string {
  return typeof value === "string" && CONNECTOR_ID_PATTERN.test(value);
}

export const CONNECTOR_ID_REQUIREMENTS = "must use 1-64 lowercase letters, numbers, hyphens, or underscores and start with a letter or number";
