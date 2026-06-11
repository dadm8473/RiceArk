import { beforeEach, describe, expect, it, vi } from "vitest";
import { updateCharacterFromLostArk } from "./characters";
import { searchRosterCharacters } from "../lostark/client";
import type { Env } from "../env";

vi.mock("../lostark/client", () => ({
  searchRosterCharacters: vi.fn()
}));

interface FakeCharacterRow {
  id: string;
  name: string;
  server_name: string;
  source: string;
  last_refresh_attempt_at: string | null;
}

function createEnv(current: FakeCharacterRow | null) {
  const runs: Array<{ sql: string; bindings: unknown[] }> = [];
  const env = {
    DB: {
      prepare(sql: string) {
        return {
          bind(...bindings: unknown[]) {
            return {
              async first() {
                if (sql.includes("FROM characters")) return current;
                return null;
              },
              async run() {
                runs.push({ sql, bindings });
                return { meta: { changes: 1 } };
              }
            };
          }
        };
      }
    }
  } as unknown as Env;
  return { env, runs };
}

describe("updateCharacterFromLostArk", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-02T10:00:00.000Z"));
    vi.mocked(searchRosterCharacters).mockReset();
  });

  it("blocks refresh attempts within one minute without calling Lost Ark", async () => {
    const { env, runs } = createEnv({
      id: "character-1",
      name: "냠수나이스1",
      server_name: "아만",
      source: "lostark",
      last_refresh_attempt_at: "2026-06-02T09:59:30.000Z"
    });

    await expect(updateCharacterFromLostArk(env, "user-1", "character-1")).resolves.toEqual({
      type: "rate_limited",
      retryAfterSeconds: 30
    });
    expect(searchRosterCharacters).not.toHaveBeenCalled();
    expect(runs).toHaveLength(0);
  });

  it("records refresh attempts before looking up the Lost Ark roster", async () => {
    const { env, runs } = createEnv({
      id: "character-1",
      name: "냠수나이스1",
      server_name: "아만",
      source: "lostark",
      last_refresh_attempt_at: "2026-06-02T09:58:30.000Z"
    });
    vi.mocked(searchRosterCharacters).mockResolvedValue([]);

    await expect(updateCharacterFromLostArk(env, "user-1", "character-1")).resolves.toBe("not_available");
    expect(searchRosterCharacters).toHaveBeenCalledWith(env, "냠수나이스1", { bypassCache: true });
    expect(runs[0]).toMatchObject({
      bindings: ["2026-06-02T10:00:00.000Z", "character-1", "user-1"]
    });
    expect(runs[0]?.sql).toContain("last_refresh_attempt_at = ?");
  });
});
