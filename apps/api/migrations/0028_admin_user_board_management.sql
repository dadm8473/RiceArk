CREATE TABLE admin_audit_logs (
  id TEXT PRIMARY KEY,
  admin_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  method TEXT NOT NULL,
  action TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_admin_audit_logs_created
  ON admin_audit_logs(created_at DESC, id DESC);
CREATE INDEX idx_admin_audit_logs_target
  ON admin_audit_logs(target_user_id, created_at DESC);
CREATE INDEX idx_admin_audit_logs_admin
  ON admin_audit_logs(admin_user_id, created_at DESC);
