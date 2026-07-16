import { Hono } from "hono";
import { getPublicJson } from "../cache/publicJsonCache";
import type { Env } from "../env";
import { fetchLostArkEventCalendarSummary, parseLostArkRewardFilters } from "../lostark/events";

export const lostArkEventRoutes = new Hono<{ Bindings: Env }>();
const LOSTARK_EVENTS_CACHE_NAMESPACE = "lostark-events:v1";
const LOSTARK_EVENTS_CACHE_TTL_SECONDS = 60;

lostArkEventRoutes.get("/lostark/events/today", async (c) => {
  const rewardFilters = parseLostArkRewardFilters(c.req.query("rewards"));
  const canonicalUrl = new URL(c.req.url);
  canonicalUrl.search = "";
  canonicalUrl.searchParams.set("rewards", rewardFilters.join(","));

  return getPublicJson(
    canonicalUrl.toString(),
    LOSTARK_EVENTS_CACHE_NAMESPACE,
    LOSTARK_EVENTS_CACHE_TTL_SECONDS,
    async () => Response.json(
      await fetchLostArkEventCalendarSummary(c.env, { rewardFilters })
    )
  );
});
