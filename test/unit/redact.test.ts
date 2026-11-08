import { expect, it } from "vitest";
import { redactSecrets } from "../../src/core/redact.js";

it.each([
  [
    "-----BEGIN RSA PRIVATE KEY-----\nprivate\n-----END RSA PRIVATE KEY-----",
    "private-key",
  ],
  ["AKIAABCDEFGHIJKLMNOP", "aws"],
  ["ASIAABCDEFGHIJKLMNOP", "aws"],
  ["ghp_abcdefghijklmnopqrstuvwxyz", "github"],
  ["github_pat_abcdefghijklmnopqrstuvwxyz", "github"],
  ["sk-test-ABCDEFGHIJKLMNOPQRSTUV", "api-key"],
  ["sk-ant-abcdefghijklmnopqrstuv", "api-key"],
  ["xoxb-1234567890-abcdefghijkl", "slack"],
  [`AIza${"a".repeat(35)}`, "google"],
  ["eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature", "jwt"],
  ["Bearer abcdefghijk", "bearer"],
  ["https://user:password@host/path", "url-credentials"],
  ["api_key = 'abcdefgh12345'", "generic"],
  ["password: abcdefgh12345", "generic"],
  ["pwd=abcdefgh12345", "generic"],
])("redacts %s", (text, kind) => {
  const result = redactSecrets(text);
  expect(result.count).toBe(1);
  expect(result.kinds).toEqual([kind]);
  expect(result.text).toContain(`[REDACTED:${kind}]`);
});
it.each([
  "token = getToken()",
  "const secret = computeSecret();",
  "token = short",
  "ordinary code and prose",
  "api_key = process.env.API_KEY",
  "[REDACTED:api-key]",
])("preserves ordinary code %s", (text) =>
  expect(redactSecrets(text)).toEqual({ text, count: 0, kinds: [] }),
);
it("redaction is idempotent", () => {
  const once = redactSecrets("token=abc123456789 secret=abc123456789");
  expect(once.count).toBe(2);
  expect(once.kinds).toEqual(["generic"]);
  expect(redactSecrets(once.text).count).toBe(0);
});
