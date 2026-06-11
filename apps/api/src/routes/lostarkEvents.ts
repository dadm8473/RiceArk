import { Hono } from "hono";
import type { Env } from "../env";
import { fetchLostArkEventCalendarSummary, parseLostArkRewardFilters } from "../lostark/events";

export const lostArkEventRoutes = new Hono<{ Bindings: Env }>();

lostArkEventRoutes.get("/lostark/events/today", async (c) => {
  const rewardFilters = parseLostArkRewardFilters(c.req.query("rewards"));
  const summary = await fetchLostArkEventCalendarSummary(c.env, { rewardFilters });
  return c.json(summary);
});
