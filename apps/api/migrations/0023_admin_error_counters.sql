-- Aggregate API error counters for the admin dashboard.
-- One row per (day, status, code, route_group); incremented only on error
-- responses so successful requests never write to D1.
CREATE TABLE IF NOT EXISTS admin_error_counters (
  day TEXT NOT NULL,
  status INTEGER NOT NULL,
  code TEXT NOT NULL,
  route_group TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (day, status, code, route_group)
);
