import { createClient } from "@supabase/supabase-js";
import { readProduct, isSafePublicUrl } from "../../../lib/extract";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request) {
  // Only signed-in members of the site can use the link reader.
  const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return Response.json({ error: "Sign in first" }, { status: 401 });

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  );
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return Response.json({ error: "Sign in first" }, { status: 401 });

  let body;
  try { body = await request.json(); } catch { body = {}; }
  const url = String(body.url || "").trim();
  if (!isSafePublicUrl(url)) return Response.json({ error: "That link can't be read" }, { status: 400 });

  const info = await readProduct(url);
  return Response.json(info, { headers: { "cache-control": "no-store" } });
}
