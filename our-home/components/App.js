"use client";

import { useEffect, useState } from "react";
import { getSupabase } from "../lib/supabaseClient";
import Home from "./Home";

export default function App() {
  const [session, setSession] = useState(undefined);
  const [householdId, setHouseholdId] = useState(undefined);

  useEffect(() => {
    const sb = getSupabase();
    sb.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = sb.auth.onAuthStateChange((_e, s) => setSession(s));
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

  if (session === undefined || (session && householdId === undefined)) {
    return <div className="splash">Our home</div>;
  }
  if (!session) return <SignIn />;
  if (!householdId) return <Welcome onReady={setHouseholdId} />;
  return <Home householdId={householdId} />;
}

function SignIn() {
  const [email, setEmail] = useState("");
  const [state, setState] = useState("idle");
  const [error, setError] = useState("");

  async function send(e) {
    e.preventDefault();
    setState("sending"); setError("");
    const { error } = await getSupabase().auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: window.location.origin },
    });
    if (error) { setError(error.message); setState("idle"); }
    else setState("sent");
  }

  return (
    <main className="gate">
      <div className="gate-inner">
        <h1 className="gate-title">Our home</h1>
        {state === "sent" ? (
          <p className="gate-text">
            Check your email. We&rsquo;ve sent a sign-in link to <strong>{email}</strong>. Open it on this device to come straight in.
          </p>
        ) : (
          <>
            <p className="gate-text">Everything you want for the house, in one beautiful place.</p>
            <form onSubmit={send} className="gate-form">
              <input
                type="email" required autoComplete="email" placeholder="Your email"
                value={email} onChange={(e) => setEmail(e.target.value)} aria-label="Email"
              />
              <button className="btn primary" disabled={state === "sending"}>
                {state === "sending" ? "Sending…" : "Email me a sign-in link"}
              </button>
            </form>
            {error && <p className="gate-error">{error}</p>}
          </>
        )}
      </div>
    </main>
  );
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
            <p className="gate-text">Start your home list, or join your partner&rsquo;s with their invite code.</p>
            <div className="gate-form">
              <button className="btn primary" onClick={create} disabled={busy}>{busy ? "Setting up…" : "Start our home"}</button>
              <button className="btn" onClick={() => setMode("join")}>I have an invite code</button>
            </div>
          </>
        ) : (
          <form onSubmit={join} className="gate-form">
            <p className="gate-text">Enter the six-letter code from your partner&rsquo;s Settings.</p>
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
