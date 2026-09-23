"use client";

import { useEffect, useState } from "react";
import { getSupabase } from "../lib/supabaseClient";
import Home from "./Home";

export default function App() {
  const [session, setSession] = useState(undefined);
  const [householdId, setHouseholdId] = useState(undefined);
  const [setupError, setSetupError] = useState("");

  // No sign-in page: each device is remembered automatically.
  useEffect(() => {
    const sb = getSupabase();
    sb.auth.getSession().then(async ({ data }) => {
      if (data.session) { setSession(data.session); return; }
      const { data: anon, error } = await sb.auth.signInAnonymously();
      if (error) setSetupError(error.message);
      else setSession(anon.session);
    });
    const { data: sub } = sb.auth.onAuthStateChange((_e, s) => { if (s) setSession(s); });
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session) { setHouseholdId(undefined); return; }
    const sb = getSupabase();
    sb.from("members")
      .select("household_id")
      .eq("user_id", session.user.id)
      .order("created_at")
      .limit(1)
      .then(({ data }) => setHouseholdId(data?.[0]?.household_id || null));
  }, [session]);

  if (setupError) {
    return (
      <main className="gate">
        <div className="gate-inner">
          <h1 className="gate-title">Our home</h1>
          <p className="gate-text">One setting needs switching on. In Supabase, open Authentication, then Sign In / Providers, and turn on &ldquo;Allow anonymous sign-ins&rdquo;. Then reload this page.</p>
          <p className="gate-error">{setupError}</p>
        </div>
      </main>
    );
  }
  if (!session || householdId === undefined) {
    return <div className="splash">Our home</div>;
  }
  if (!householdId) return <Welcome onReady={setHouseholdId} />;
  return <Home householdId={householdId} />;
}

function Welcome({ onReady }) {
  const [mode, setMode] = useState("choose");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function create() {
    setBusy(true); setError("");
    const { data, error } = await getSupabase().rpc("create_household", { home_name: "Our home" });
    setBusy(false);
    if (error) setError(error.message); else onReady(data);
  }
  async function join(e) {
    e.preventDefault();
    setBusy(true); setError("");
    const { data, error } = await getSupabase().rpc("join_household", { code });
    setBusy(false);
    if (error) setError("That code doesn't match a home. Check it and try again.");
    else onReady(data);
  }

  return (
    <main className="gate">
      <div className="gate-inner">
        <h1 className="gate-title">Welcome</h1>
        {mode === "choose" ? (
          <>
            <p className="gate-text">Start your home list, or join one that&rsquo;s already set up using its invite code (it&rsquo;s in Settings on any device that&rsquo;s already in).</p>
            <div className="gate-form">
              <button className="btn primary" onClick={create} disabled={busy}>{busy ? "Setting up…" : "Start our home"}</button>
              <button className="btn" onClick={() => setMode("join")}>I have an invite code</button>
            </div>
          </>
        ) : (
          <form onSubmit={join} className="gate-form">
            <p className="gate-text">Enter the six-character invite code from Settings on a device that&rsquo;s already in.</p>
            <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="Invite code" maxLength={6} aria-label="Invite code" required />
            <button className="btn primary" disabled={busy}>{busy ? "Joining…" : "Join home"}</button>
            <button type="button" className="btn ghost" onClick={() => setMode("choose")}>Back</button>
          </form>
        )}
        {error && <p className="gate-error">{error}</p>}
      </div>
    </main>
  );
}
