import { describe, it, expect } from "vitest";
import { ApiException } from "@kubernetes/client-node";
import { QuotaExceededError, isQuotaExceeded } from "#src/sandbox/k8s/quota.js";

// ApiException<T>(code, message, body, headers). Its `.message` is COMPOSED as
// `HTTP-Code: … \nMessage: <message> \nBody: <JSON.stringify(body)> …`, so the
// top-level `message` arg AND the serialized body both land in `err.message`.
// `body` defaults to `{ message }` (the common k8s Status shape); pass an
// explicit `body` to exercise the body-less path.
function apiErr(code: number, message: string, body: unknown = { message }): ApiException<unknown> {
  return new ApiException(code, message, body, {});
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

  it("detects the 'failed quota: must specify …' admission phrasing too", () => {
    // The ResourceQuota plugin's OTHER rejection: a compute quota exists but the
    // pod declares no request/limit for a tracked resource. Still a quota
    // rejection → backpressure, not a hard failure.
    const err = apiErr(
      403,
      'pods "sandbox-x" is forbidden: failed quota: compute: must specify requests.cpu,requests.memory',
    );
    expect(isQuotaExceeded(err)).toBe(true);
  });

  it("detects a quota rejection carried only in the composed message (body has no message field)", () => {
    // `body.message` is absent, so the `body?.message` half of the dual-read
    // contributes nothing — the match must come from the composed `err.message`.
    // This pins the `err.message` read as load-bearing: dropping it regresses.
    const err = apiErr(403, "pods is forbidden: exceeded quota: sandbox-quota", {});
    expect(isQuotaExceeded(err)).toBe(true);
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
