import { describe, expect, it } from "vitest";
import { ApiClientError } from "../../api/client";
import { formatSessionError } from "./useSession";

describe("formatSessionError", () => {
  it("treats unauthorized as an anonymous visitor state", () => {
    const error = new ApiClientError(401, "unauthorized", "Login required");

    expect(formatSessionError(error)).toBeNull();
  });

  it("surfaces unexpected session errors", () => {
    expect(formatSessionError(new Error("network down"))).toBe("network down");
  });
});
