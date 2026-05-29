INSERT OR IGNORE INTO tasks (
  id,
  user_id,
  name,
  scope,
  reset_type,
  reset_rule_json,
  sort_order,
  enabled,
  is_template
) VALUES
  ('template-kurzan-front', NULL, '쿠르잔 전선', 'character', 'daily', '{"type":"daily","hour":6,"timezone":"Asia/Seoul"}', 10, 1, 1),
  ('template-guardian-raid', NULL, '가디언 토벌', 'character', 'daily', '{"type":"daily","hour":6,"timezone":"Asia/Seoul"}', 20, 1, 1),
  ('template-act4-armoche', NULL, '4막: 아르모체', 'character', 'weekly', '{"type":"weekly","weekday":3,"hour":6,"timezone":"Asia/Seoul"}', 30, 1, 1),
  ('template-kazeros-epilogue', NULL, '종막: 카제로스', 'character', 'weekly', '{"type":"weekly","weekday":3,"hour":6,"timezone":"Asia/Seoul"}', 40, 1, 1),
  ('template-serca', NULL, '세르카', 'roster', 'custom', '{"type":"custom","intervalDays":1,"hour":6,"timezone":"Asia/Seoul","anchorDate":"2026-05-29"}', 50, 1, 1);
