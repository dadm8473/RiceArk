import type { Env } from "../env";

export interface PatchNote {
  id: string;
  title: string;
  body: string;
  publishedAt: string;
  updatedAt: string;
}

type PatchNoteRow = {
  id: string;
  title: string;
  body: string;
  published_at: string;
  updated_at: string;
};

function toPatchNote(row: PatchNoteRow): PatchNote {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    publishedAt: row.published_at,
    updatedAt: row.updated_at
  };
}

async function findPatchNote(env: Env, id: string): Promise<PatchNote | null> {
  const row = await env.DB.prepare(
    `SELECT id, title, body, published_at, updated_at
     FROM patch_notes
     WHERE id = ?`
  )
    .bind(id)
    .first<PatchNoteRow>();
  return row ? toPatchNote(row) : null;
}

export async function listPatchNotes(env: Env): Promise<PatchNote[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, title, body, published_at, updated_at
     FROM patch_notes
     ORDER BY published_at DESC, id DESC
     LIMIT 50`
  ).all<PatchNoteRow>();
  return results.map(toPatchNote);
}

export async function createPatchNote(
  env: Env,
  input: { title: string; body: string; authorUserId: string }
): Promise<PatchNote> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO patch_notes (id, title, body, author_user_id)
     VALUES (?, ?, ?, ?)`
  )
    .bind(id, input.title, input.body, input.authorUserId)
    .run();

  const note = await findPatchNote(env, id);
  if (!note) throw new Error("Created patch note could not be loaded");
  return note;
}

export async function updatePatchNote(env: Env, id: string, input: { title: string; body: string }): Promise<PatchNote | null> {
  const existing = await findPatchNote(env, id);
  if (!existing) return null;

  await env.DB.prepare(
    `UPDATE patch_notes
     SET title = ?, body = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  )
    .bind(input.title, input.body, id)
    .run();
  return findPatchNote(env, id);
}

export async function deletePatchNote(env: Env, id: string): Promise<boolean> {
  const existing = await findPatchNote(env, id);
  if (!existing) return false;

  await env.DB.prepare("DELETE FROM patch_notes WHERE id = ?").bind(id).run();
  return true;
}
