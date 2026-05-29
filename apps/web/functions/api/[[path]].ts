import apiApp from "@riceark/api/src/index";
import type { Env } from "@riceark/api/src/env";

export const onRequest: PagesFunction<Env> = (context) => {
  return apiApp.fetch(context.request, context.env, context);
};
