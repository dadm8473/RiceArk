import { describe, expect, it } from "vitest";
import app from "../index";
import type { Env } from "../env";

const envBase = {
  APP_ORIGIN: "http://127.0.0.1:5173",
  COOKIE_DOMAIN: "127.0.0.1",
  ENVIRONMENT: "test",
  SESSION_SECRET: "test-secret",
  ADMIN_OAUTH_ALLOWLIST: "discord:326685778656755713",
  CACHE: {} as KVNamespace
};

type PatchNoteRow = {
  id: string;
  title: string;
  body: string;
  published_at: string;
  updated_at: string;
  author_user_id: string;
};

function createPatchNoteDb(providerUserId: string, seed: PatchNoteRow[] = []): D1Database {
  const rows = [...seed];

  return {
    prepare(sql: string) {
      let bound: unknown[] = [];
      const statement = {
        bind: (...values: unknown[]) => {
          bound = values;
          return statement;
        },
        first: async () => {
          if (sql.includes("FROM sessions")) {
            return { id: "user-admin", display_name: "수빈", avatar_url: null };
          }
          if (sql.includes("FROM patch_notes") && sql.includes("WHERE id = ?")) {
            return rows.find((row) => row.id === bound[0]) ?? null;
          }
          return null;
        },
        all: async () => {
          if (sql.includes("FROM oauth_accounts")) {
            return { results: [{ provider: "discord", provider_user_id: providerUserId }] };
          }
          if (sql.includes("FROM patch_notes")) {
            return {
              results: [...rows].sort((left, right) => right.published_at.localeCompare(left.published_at))
            };
          }
          return { results: [] };
        },
        run: async () => {
          if (sql.includes("INSERT INTO patch_notes")) {
            const now = "2026-06-16 12:00:00";
            rows.push({
              id: String(bound[0]),
              title: String(bound[1]),
              body: String(bound[2]),
              author_user_id: String(bound[3]),
              published_at: now,
              updated_at: now
            });
          }
          if (sql.includes("UPDATE patch_notes")) {
            const row = rows.find((candidate) => candidate.id === bound[2]);
            if (row) {
              row.title = String(bound[0]);
              row.body = String(bound[1]);
              row.updated_at = "2026-06-16 12:30:00";
            }
          }
          if (sql.includes("DELETE FROM patch_notes")) {
            const index = rows.findIndex((row) => row.id === bound[0]);
            if (index >= 0) rows.splice(index, 1);
          }
          return { success: true };
        }
      };
      return statement;
    }
  } as unknown as D1Database;
}

function envWithPatchNotes(providerUserId = "326685778656755713", seed: PatchNoteRow[] = []): Env {
  return {
    ...envBase,
    DB: createPatchNoteDb(providerUserId, seed)
  } as unknown as Env;
}

describe("patch note routes", () => {
  it("lists published patch notes without requiring login", async () => {
    const res = await app.request(
      "/api/patch-notes",
      {},
      envWithPatchNotes("other", [
        {
          id: "note-old",
          title: "초기 공개",
          body: "첫 패치입니다.",
          published_at: "2026-06-15 09:00:00",
          updated_at: "2026-06-15 09:00:00",
          author_user_id: "user-admin"
        },
        {
          id: "note-new",
          title: "체크 개선",
          body: "체크박스 동작을 개선했습니다.",
          published_at: "2026-06-16 09:00:00",
          updated_at: "2026-06-16 09:00:00",
          author_user_id: "user-admin"
        }
      ])
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      notes: [
        { id: "note-new", title: "체크 개선", body: "체크박스 동작을 개선했습니다." },
        { id: "note-old", title: "초기 공개", body: "첫 패치입니다." }
      ]
    });
  });

  it("allows only allowlisted admins to create patch notes", async () => {
    const rejected = await app.request(
      "/api/patch-notes",
      {
        method: "POST",
        headers: { cookie: "riceark_session=test-session", "content-type": "application/json" },
        body: JSON.stringify({ title: "몰래 작성", body: "비관리자는 작성할 수 없습니다." })
      },
      envWithPatchNotes("not-admin")
    );

    expect(rejected.status).toBe(403);

    const accepted = await app.request(
      "/api/patch-notes",
      {
        method: "POST",
        headers: { cookie: "riceark_session=test-session", "content-type": "application/json" },
        body: JSON.stringify({ title: "패치노트 ✨", body: "관리자만 게시합니다.\n줄바꿈도 유지합니다." })
      },
      envWithPatchNotes()
    );

    expect(accepted.status).toBe(201);
    await expect(accepted.json()).resolves.toMatchObject({
      note: {
        title: "패치노트 ✨",
        body: "관리자만 게시합니다.\n줄바꿈도 유지합니다."
      }
    });
  });

  it("allows admins to update and delete patch notes", async () => {
    const seed: PatchNoteRow[] = [
      {
        id: "note-1",
        title: "이전 제목",
        body: "이전 내용",
        published_at: "2026-06-16 09:00:00",
        updated_at: "2026-06-16 09:00:00",
        author_user_id: "user-admin"
      }
    ];

    const updated = await app.request(
      "/api/patch-notes/note-1",
      {
        method: "PATCH",
        headers: { cookie: "riceark_session=test-session", "content-type": "application/json" },
        body: JSON.stringify({ title: "수정된 제목", body: "수정된 내용" })
      },
      envWithPatchNotes("326685778656755713", seed)
    );

    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toMatchObject({
      note: { id: "note-1", title: "수정된 제목", body: "수정된 내용" }
    });

    const deleted = await app.request(
      "/api/patch-notes/note-1",
      { method: "DELETE", headers: { cookie: "riceark_session=test-session" } },
      envWithPatchNotes("326685778656755713", seed)
    );

    expect(deleted.status).toBe(204);
  });
});
