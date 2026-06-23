import { config } from "./config.js";

export function checkAuth(c: any): boolean {
  if (!config.server.apiKey) return true;
  const auth = c.req.header("Authorization");
  return !!(auth && auth.startsWith("Bearer ") && auth.slice(7) === config.server.apiKey);
}
