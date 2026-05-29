import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Pages routing config", () => {
  it("invokes Pages Functions only for API routes", async () => {
    const raw = await readFile(new URL("../public/_routes.json", import.meta.url), "utf8");
    expect(JSON.parse(raw)).toEqual({
      version: 1,
      include: ["/api/*"],
      exclude: []
    });
  });
});
