/**
 * Timing-safe comparison of a provided header value against an expected secret.
 *
 * Returns false when there is nothing to compare (missing/empty expected, or a
 * null actual). When both values are present they are UTF-8 encoded; a length
 * mismatch returns false first, then a constant-time byte comparison decides
 * equality. The length check happens before the byte loop — length divergence
 * is not secret, and comparing unequal-length buffers in lockstep leaks nothing
 * beyond the (public) lengths.
 */
export function timingSafeTokenMatch(
  actualValue: string | null,
  expectedValue: string | undefined,
): boolean {
  if (expectedValue === undefined || expectedValue === "") {
    return false;
  }
  if (actualValue === null) {
    return false;
  }

  const encoder = new TextEncoder();
  const actualBytes = encoder.encode(actualValue);
  const expectedBytes = encoder.encode(expectedValue);

  if (actualBytes.length !== expectedBytes.length) {
    return false;
  }

  for (let i = 0; i < actualBytes.length; i++) {
    if (actualBytes[i] !== expectedBytes[i]) {
      return false;
    }
  }
  return true;
}

/** Extract a bearer token from an `Authorization` header value, or null. */
export function bearerToken(header: string | null): string | null {
  if (header === null) {
    return null;
  }
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match === null ? null : match[1];
}

/**
 * Validate the `Authorization: Bearer <token>` header on an internal request
 * against the configured {@link Env.INTERNAL_API_TOKEN}. Returns true only when
 * the token is present and matches.
 */
export function isInternalAuthorized(request: Request, expectedToken: string): boolean {
  return timingSafeTokenMatch(
    bearerToken(request.headers.get("Authorization")),
    expectedToken,
  );
}
