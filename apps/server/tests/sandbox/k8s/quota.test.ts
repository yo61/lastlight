import { describe, it, expect } from "vitest";
import { ApiException } from "@kubernetes/client-node";
import { QuotaExceededError, isQuotaExceeded } from "../../../src/sandbox/k8s/quota.js";

function apiErr(code: number, message: string): ApiException<unknown> {
  // ApiException<T>(code, message, body, headers)
  return new ApiException(code, message, { message }, {});
}

describe("isQuotaExceeded", () => {
  it("detects a 403 quota rejection by message", () => {
    const err = apiErr(
      403,
      'pods "sandbox-x" is forbidden: exceeded quota: sandbox-quota, requested: pods=1, used: pods=5, limited: pods=5',
    );
    expect(isQuotaExceeded(err)).toBe(true);
  });

  it("is case-insensitive on the quota phrase", () => {
    expect(isQuotaExceeded(apiErr(403, "Exceeded Quota: foo"))).toBe(true);
  });

  it("ignores a 403 RBAC-forbidden error (not a quota)", () => {
    const err = apiErr(403, 'pods is forbidden: User "sa" cannot create resource "pods"');
    expect(isQuotaExceeded(err)).toBe(false);
  });

  it("ignores a 409 conflict", () => {
    expect(isQuotaExceeded(apiErr(409, "exceeded quota"))).toBe(false); // wrong code
  });

  it("ignores non-ApiException errors", () => {
    expect(isQuotaExceeded(new Error("exceeded quota"))).toBe(false);
  });
});

describe("QuotaExceededError", () => {
  it("carries name + message", () => {
    const e = new QuotaExceededError("exceeded quota: pods");
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("QuotaExceededError");
    expect(e.message).toContain("exceeded quota");
  });
});
