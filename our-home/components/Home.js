"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getSupabase } from "../lib/supabaseClient";
import {
  DEFAULT_SECTIONS, findUrls, guessSection, lineTotal, money, shopFromUrl, titleFromUrl, totals,
} from "../lib/helpers";

const newId = () =>
  typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
      });

const sectionsOf = (room) => (room?.sections?.length ? room.sections : DEFAULT_SECTIONS);

export default function Home({ householdId }) {
  const sb = getSupabase();
  const [home, setHome] = useState(null);
  const [rooms, setRooms] = useState([]);
  const [items, setItems] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [view, setView] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [roomMenu, setRoomMenu] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);
  const reloadTimer = useRef(null);

  const currency = home?.currency || "GBP";

  const load = useCallback(async () => {
    const [h, r, i] = await Promise.all([
      sb.from("households").select("*").eq("id", householdId).single(),
      sb.from("rooms").select("*").eq("household_id", householdId).order("position").order("created_at"),
      sb.from("items").select("*").eq("household_id", householdId).order("created_at"),
    ]);
    if (h.data) setHome(h.data);
    if (r.data) setRooms(r.data);
    if (i.data) {
      // Keep items that are still being read on this device.
      setItems((prev) => {
        const loading = prev.filter((p) => p._local && !i.data.some((d) => d.id === p.id));
        const map = new Map(prev.map((p) => [p.id, p]));
        return [...i.data.map((d) => (map.get(d.id)?._reading ? { ...d, ...map.get(d.id) } : d)), ...loading];
      });
    }
    setLoaded(true);
  }, [sb, householdId]);

  useEffect(() => {
    load();
    const schedule = () => {
      clearTimeout(reloadTimer.current);
      reloadTimer.current = setTimeout(load, 500);
    };
    const channel = sb
      .channel(`home-${householdId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "items", filter: `household_id=eq.${householdId}` }, schedule)
      .on("postgres_changes", { event: "*", schema: "public", table: "rooms", filter: `household_id=eq.${householdId}` }, schedule)
      .subscribe();
    const onFocus = () => schedule();
    window.addEventListener("focus", onFocus);
    return () => { sb.removeChannel(channel); window.removeEventListener("focus", onFocus); };
  }, [sb, householdId, load]);

  // Remember the last room viewed.
  useEffect(() => {
    if (!loaded) return;
    if (view && (view === "all" || rooms.some((r) => r.id === view))) return;
    let saved = null;
    try { saved = localStorage.getItem("ourhome:view"); } catch {}
    if (saved && (saved === "all" || rooms.some((r) => r.id === saved))) setView(saved);
    else setView(rooms[0]?.id || "all");
  }, [loaded, rooms, view]);

  function go(v) {
    setView(v);
    try { localStorage.setItem("ourhome:view", v); } catch {}
    window.scrollTo({ top: 0 });
  }

  function showToast(message, undo) {
    clearTimeout(toastTimer.current);
    setToast({ message, undo, key: Date.now() });
    toastTimer.current = setTimeout(() => setToast(null), undo ? 8000 : 4000);
  }

  const room = rooms.find((r) => r.id === view) || null;
  const roomItems = useMemo(() => items.filter((i) => i.room_id === view), [items, view]);
  const houseItems = useMemo(() => items.filter((i) => rooms.some((r) => r.id === i.room_id)), [items, rooms]);

  /* ---------- items ---------- */
  async function readLink(url) {
    try {
      const { data } = await sb.auth.getSession();
      const r = await fetch("/api/preview", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${data.session?.access_token || ""}` },
        body: JSON.stringify({ url }),
      });
      return r.ok ? await r.json() : null;
    } catch {
      return null;
    }
  }

  async function addLinks(urls, targetRoom) {
    for (const url of urls) addOne(url, targetRoom);
  }

  async function addOne(url, targetRoom) {
    const id = newId();
    const row = {
      id, household_id: householdId, room_id: targetRoom.id,
      section: guessSection(url, sectionsOf(targetRoom)),
      url, title: titleFromUrl(url) || shopFromUrl(url), shop: shopFromUrl(url),
      image_url: null, price: null, currency: null, qty: 1, included: true, notes: null,
      status: "loading", created_at: new Date().toISOString(),
    };
    setItems((p) => [...p, { ...row, _local: true, _reading: true }]);
    const { error } = await sb.from("items").insert(row);
    if (error) {
      setItems((p) => p.filter((x) => x.id !== id));
      showToast("That link didn't save. Check your connection and try again.");
      return;
    }
    const info = await readLink(url);
    const patch = {
      title: info?.title || row.title,
      shop: info?.shop || row.shop,
      image_url: info?.image || null,
      price: info?.price ?? null,
      currency: info?.currency || null,
      status: info ? (info.price != null ? "ready" : "needs_price") : "failed",
    };
    patch.section = guessSection(`${patch.title} ${url}`, sectionsOf(targetRoom));
    setItems((p) => p.map((x) => (x.id === id ? { ...x, ...patch, _local: false, _reading: false } : x)));
    await sb.from("items").update(patch).eq("id", id);
  }

  async function updateItem(id, patch) {
    setItems((p) => p.map((x) => (x.id === id ? { ...x, ...patch } : x)));
    const { error } = await sb.from("items").update(patch).eq("id", id);
    if (error) { showToast("That change didn't save. Try again."); load(); }
  }

  async function refreshItem(it) {
    setItems((p) => p.map((x) => (x.id === it.id ? { ...x, status: "loading", _reading: true } : x)));
    const info = await readLink(it.url);
    const patch = info
      ? {
          title: info.title || it.title, shop: info.shop || it.shop,
          image_url: info.image || it.image_url,
          price: info.price ?? it.price, currency: info.currency || it.currency,
          status: (info.price ?? it.price) != null ? "ready" : "needs_price",
        }
      : { status: it.price != null ? "ready" : "failed" };
    setItems((p) => p.map((x) => (x.id === it.id ? { ...x, ...patch, _reading: false } : x)));
    await sb.from("items").update(patch).eq("id", it.id);
    showToast(info ? "Details refreshed." : "Couldn't reach that page just now.");
  }

  async function removeItem(it) {
    setEditingId(null);
    setItems((p) => p.filter((x) => x.id !== it.id));
    const { error } = await sb.from("items").delete().eq("id", it.id);
    if (error) { showToast("That didn't delete. Try again."); load(); return; }
    showToast(`Removed ${it.title || "item"}.`, async () => {
      const { _local, _reading, ...row } = it;
      setItems((p) => [...p, row]);
      await sb.from("items").insert(row);
    });
  }

  /* ---------- rooms ---------- */
  async function addRoom(name) {
    const clean = name.trim();
    if (!clean) return;
    const row = { id: newId(), household_id: householdId, name: clean, position: rooms.length, sections: DEFAULT_SECTIONS };
    setRooms((p) => [...p, { ...row, created_at: new Date().toISOString() }]);
    go(row.id);
    const { error } = await sb.from("rooms").insert(row);
    if (error) { showToast("That room didn't save. Try again."); load(); }
  }

  async function renameRoom(r, name) {
    const clean = name.trim();
    if (!clean || clean === r.name) return;
    setRooms((p) => p.map((x) => (x.id === r.id ? { ...x, name: clean } : x)));
    await sb.from("rooms").update({ name: clean }).eq("id", r.id);
  }

  async function removeRoom(r) {
    const saved = items.filter((i) => i.room_id === r.id);
    setRoomMenu(false);
    setRooms((p) => p.filter((x) => x.id !== r.id));
    setItems((p) => p.filter((x) => x.room_id !== r.id));
    const rest = rooms.filter((x) => x.id !== r.id);
    go(rest[0]?.id || "all");
    const { error } = await sb.from("rooms").delete().eq("id", r.id);
    if (error) { showToast("That room didn't delete. Try again."); load(); return; }
    showToast(`Removed ${r.name}${saved.length ? ` and its ${saved.length} item${saved.length === 1 ? "" : "s"}` : ""}.`, async () => {
      const { error: e1 } = await sb.from("rooms").insert({ id: r.id, household_id: r.household_id, name: r.name, sections: r.sections, position: r.position, created_at: r.created_at });
      if (!e1 && saved.length) await sb.from("items").insert(saved.map(({ _local, _reading, ...row }) => row));
      await load();
      go(r.id);
    });
  }

  async function addSection(r, name) {
    const clean = name.trim();
    if (!clean) return null;
    const secs = sectionsOf(r);
    const existing = secs.find((s) => s.toLowerCase() === clean.toLowerCase());
    if (existing) return existing;
    const next = [...secs, clean];
    setRooms((p) => p.map((x) => (x.id === r.id ? { ...x, sections: next } : x)));
    await sb.from("rooms").update({ sections: next }).eq("id", r.id);
    return clean;
  }

  async function saveHome(patch) {
    setHome((h) => ({ ...h, ...patch }));
    await sb.from("households").update(patch).eq("id", householdId);
  }

  const editing = items.find((i) => i.id === editingId) || null;
  const house = totals(houseItems);

  return (
    <>
      <header className="top">
        <div className="brand">{home?.name || "Our home"}</div>
        <button className="btn ghost" onClick={() => setSettingsOpen(true)}>Settings</button>
      </header>

      <nav className="tabs" aria-label="Rooms">
        <div className="tabs-inner">
          {rooms.length > 1 && (
            <button className="tab" aria-current={view === "all"} onClick={() => go("all")}>Whole house</button>
          )}
          {rooms.map((r) => (
            <button key={r.id} className="tab" aria-current={view === r.id} onClick={() => go(r.id)}>{r.name}</button>
          ))}
          <AddRoom onAdd={addRoom} />
        </div>
      </nav>

      <main className="page">
        {!loaded ? (
          <p className="quiet">Opening your home…</p>
        ) : view === "all" || !room ? (
          <Overview rooms={rooms} items={houseItems} currency={currency} onOpen={go} onAddRoom={addRoom} />
        ) : (
          <RoomView
            room={room}
            items={roomItems}
            currency={currency}
            onAdd={(urls) => addLinks(urls, room)}
            onEdit={setEditingId}
            onToggle={(it) => updateItem(it.id, { included: !(it.included !== false) })}
            onRoomMenu={() => setRoomMenu(true)}
          />
        )}
      </main>

      <footer className="tally" aria-live="polite">
        <div className="tally-main">
          <span className="tally-label">Your home</span>
          <span className="tally-big">{money(house.included, currency)}</span>
        </div>
        <div className="tally-side">
          {house.count
            ? <>{house.includedCount} of {house.count} pieces<br /><span>{money(house.all, currency)} if you bought everything</span></>
            : "Paste a link to get started"}
        </div>
        {room && view !== "all" && (
          <div className="tally-room">
            <span className="tally-label">{room.name}</span>
            <span className="tally-mid">{money(totals(roomItems).included, currency)}</span>
          </div>
        )}
      </footer>

      {editing && (
        <EditSheet
          key={editing.id}
          item={editing}
          rooms={rooms}
          currency={currency}
          onClose={() => setEditingId(null)}
          onSave={(patch) => { updateItem(editing.id, patch); setEditingId(null); }}
          onRefresh={() => refreshItem(editing)}
          onRemove={() => removeItem(editing)}
          onAddSection={addSection}
        />
      )}

      {roomMenu && room && (
        <RoomSheet room={room} count={roomItems.length} onClose={() => setRoomMenu(false)}
          onRename={(n) => { renameRoom(room, n); setRoomMenu(false); }}
          onRemove={() => removeRoom(room)} />
      )}

      {settingsOpen && home && (
        <SettingsSheet home={home} onClose={() => setSettingsOpen(false)} onSave={saveHome}
          onSignOut={() => sb.auth.signOut()} onCopied={() => showToast("Invite code copied.")} />
      )}

      {toast && (
        <div className="toast" key={toast.key} role="status">
          <span>{toast.message}</span>
          {toast.undo && (
            <button onClick={() => { const u = toast.undo; setToast(null); u(); }}>Undo</button>
          )}
        </div>
      )}
    </>
  );
}

/* ---------- pieces ---------- */

function AddRoom({ onAdd }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  if (!open) return <button className="tab add" onClick={() => setOpen(true)}>+ Room</button>;
  return (
    <form className="tab-form" onSubmit={(e) => { e.preventDefault(); onAdd(name); setName(""); setOpen(false); }}>
      <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Room name"
        onBlur={() => { if (!name.trim()) setOpen(false); }} maxLength={40} aria-label="New room name" />
    </form>
  );
}

function PasteBar({ roomName, onAdd }) {
  const [value, setValue] = useState("");
  const [hint, setHint] = useState("");

  function submit(text) {
    const urls = findUrls(text);
    if (!urls.length) { setHint("That doesn't look like a link. Copy the web address from the shop's page."); return; }
    onAdd(urls);
    setValue(""); setHint(urls.length > 1 ? `Adding ${urls.length} pieces…` : "");
    if (urls.length > 1) setTimeout(() => setHint(""), 3000);
  }

  return (
    <form className="paste" onSubmit={(e) => { e.preventDefault(); submit(value); }}>
      <input
        value={value}
        onChange={(e) => { setValue(e.target.value); setHint(""); }}
        onPaste={(e) => {
          const text = e.clipboardData.getData("text");
          if (findUrls(text).length) { e.preventDefault(); submit(text); }
        }}
        placeholder={`Paste a link to add to ${roomName}`}
        inputMode="url" autoComplete="off" aria-label={`Paste a product link for ${roomName}`}
      />
      <button className="btn primary">Add</button>
      {hint && <p className="paste-hint">{hint}</p>}
    </form>
  );
}

function RoomView({ room, items, currency, onAdd, onEdit, onToggle, onRoomMenu }) {
  const t = totals(items);
  const sections = sectionsOf(room);
  const groups = [...sections, ...new Set(items.map((i) => i.section).filter((s) => !sections.includes(s)))]
    .map((s) => ({ name: s, items: items.filter((i) => i.section === s) }))
    .filter((g) => g.items.length);

  return (
    <>
      <div className="room-head">
        <div>
          <h1 className="room-title">{room.name}</h1>
          <p className="room-sub">
            {t.count ? `${money(t.included, currency)} across ${t.includedCount} of ${t.count} piece${t.count === 1 ? "" : "s"}` : "Nothing added yet"}
          </p>
        </div>
        <button className="btn ghost" onClick={onRoomMenu}>Room options</button>
      </div>

      <PasteBar roomName={room.name} onAdd={onAdd} />

      {!groups.length && (
        <p className="empty-note">Copy a product link from any shop, paste it above, and the photo and price will appear here. Pieces are sorted into furniture, appliances, storage and decor for you.</p>
      )}

      {groups.map((g) => {
        const st = totals(g.items);
        return (
          <section className="section" key={g.name}>
            <div className="sec-head">
              <h2>{g.name}</h2>
              <span className="sec-meta">{money(st.included, currency)}</span>
            </div>
            <div className="grid">
              {g.items.map((it) => (
                <Card key={it.id} item={it} currency={currency} onEdit={() => onEdit(it.id)} onToggle={() => onToggle(it)} />
              ))}
            </div>
          </section>
        );
      })}
    </>
  );
}

function Card({ item, currency, onEdit, onToggle }) {
  const [imgFailed, setImgFailed] = useState(false);
  const included = item.included !== false;
  const loading = item.status === "loading";
  const q = Math.max(1, Number(item.qty) || 1);
  const hasPrice = item.price != null && Number(item.price) > 0;
  const cur = item.currency || currency;

  return (
    <article className={`card${included ? "" : " off"}${loading ? " loading" : ""}`}>
      <div className="card-img">
        <a href={item.url} target="_blank" rel="noopener noreferrer" aria-label={`Open ${item.title} in the shop`}>
          {item.image_url && !imgFailed ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={item.image_url} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setImgFailed(true)} />
          ) : (
            <div className="card-blank">
              <span>{loading ? "" : (item.title || item.shop || "?").charAt(0).toUpperCase()}</span>
              {loading && <em>Finding photo and price…</em>}
            </div>
          )}
        </a>
        {!loading && (
          <button className={`check${included ? " on" : ""}`} onClick={onToggle}
            aria-pressed={included} aria-label={included ? "Included in total. Tap to set aside" : "Set aside. Tap to include"}>
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.6" /></svg>
          </button>
        )}
      </div>
      <button className="card-body" onClick={onEdit} disabled={loading}>
        <span className="card-shop">{item.shop}</span>
        <span className="card-title">{item.title || "Untitled"}</span>
        <span className={`card-price${hasPrice ? "" : " none"}`}>
          {loading ? "\u00a0" : hasPrice ? (
            <>{money(lineTotal(item), cur)}{q > 1 && <small> {q} × {money(item.price, cur)}</small>}</>
          ) : "Add price"}
        </span>
      </button>
    </article>
  );
}

function Overview({ rooms, items, currency, onOpen, onAddRoom }) {
  const t = totals(items);
  const max = Math.max(1, ...rooms.map((r) => totals(items.filter((i) => i.room_id === r.id)).included));
  if (!rooms.length) {
    return (
      <div className="empty">
        <h1 className="room-title">Begin with a room.</h1>
        <p className="empty-note">Add a room above, then paste links to the things you love.</p>
        <button className="btn primary" onClick={() => onAddRoom("Living room")}>Add a living room</button>
      </div>
    );
  }
  return (
    <>
      <div className="room-head">
        <div>
          <h1 className="room-title">Whole house</h1>
          <p className="room-sub">{t.count ? `${money(t.included, currency)} across ${rooms.length} rooms` : "Your rooms and their totals will appear here"}</p>
        </div>
      </div>
      <div className="ov">
        {rooms.map((r) => {
          const rt = totals(items.filter((i) => i.room_id === r.id));
          return (
            <button key={r.id} className="ov-row" onClick={() => onOpen(r.id)}>
              <span className="ov-name">{r.name}</span>
              <span className="ov-bar"><span style={{ width: `${(rt.included / max) * 100}%` }} /></span>
              <span className="ov-val">{money(rt.included, currency)}<small>{rt.count} piece{rt.count === 1 ? "" : "s"}</small></span>
            </button>
          );
        })}
      </div>
    </>
  );
}

function Sheet({ title, onClose, children }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    document.body.classList.add("locked");
    return () => { document.removeEventListener("keydown", onKey); document.body.classList.remove("locked"); };
  }, [onClose]);
  return (
    <div className="sheet-wrap" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title}>
        <div className="sheet-head">
          <h2>{title}</h2>
          <button className="sheet-close" onClick={onClose} aria-label="Close">
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 3l10 10M13 3L3 13" stroke="currentColor" strokeWidth="1.3" /></svg>
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function EditSheet({ item, rooms, currency, onClose, onSave, onRefresh, onRemove, onAddSection }) {
  const [f, setF] = useState({
    title: item.title || "", price: item.price ?? "", qty: item.qty || 1, room_id: item.room_id,
    section: item.section, notes: item.notes || "", included: item.included !== false,
  });
  const [newSec, setNewSec] = useState(null);
  const room = rooms.find((r) => r.id === f.room_id);
  const secs = sectionsOf(room);
  const set = (k) => (e) => setF((p) => ({ ...p, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  const loading = item.status === "loading";

  async function save(e) {
    e.preventDefault();
    let section = f.section;
    if (newSec !== null && newSec.trim()) section = (await onAddSection(room, newSec)) || section;
    if (!sectionsOf(room).includes(section) && newSec === null) section = guessSection(f.title, sectionsOf(room));
    onSave({
      title: f.title.trim() || item.title,
      price: f.price === "" ? null : Math.max(0, Number(f.price)),
      qty: Math.max(1, parseInt(f.qty, 10) || 1),
      room_id: f.room_id, section, notes: f.notes.trim() || null, included: f.included,
      status: f.price === "" ? item.status === "failed" ? "failed" : "needs_price" : "ready",
    });
  }

  return (
    <Sheet title="Edit piece" onClose={onClose}>
      <form onSubmit={save} className="form">
        <div className="edit-top">
          {item.image_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={item.image_url} alt="" referrerPolicy="no-referrer" />
          ) : <div className="edit-blank" />}
          <div>
            <p className="card-shop">{item.shop}</p>
            <a className="link" href={item.url} target="_blank" rel="noopener noreferrer">Open in shop</a>
            <button type="button" className="link" onClick={onRefresh} disabled={loading}>
              {loading ? "Refreshing…" : "Refresh photo and price"}
            </button>
          </div>
        </div>
        {item.status === "failed" && <p className="note">This shop didn&rsquo;t share its details. Add the name and price below.</p>}
        <label className="field"><span>Name</span><input value={f.title} onChange={set("title")} /></label>
        <div className="row">
          <label className="field"><span>Price each ({(item.currency || currency)})</span>
            <input type="number" inputMode="decimal" min="0" step="0.01" value={f.price} onChange={set("price")} placeholder="0" autoFocus={item.price == null} />
          </label>
          <label className="field"><span>Quantity</span><input type="number" min="1" step="1" value={f.qty} onChange={set("qty")} /></label>
        </div>
        <div className="row">
          <label className="field"><span>Room</span>
            <select value={f.room_id} onChange={(e) => { const r = rooms.find((x) => x.id === e.target.value); setF((p) => ({ ...p, room_id: e.target.value, section: sectionsOf(r).includes(p.section) ? p.section : guessSection(p.title, sectionsOf(r)) })); }}>
              {rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </label>
          <label className="field"><span>Section</span>
            {newSec === null ? (
              <select value={secs.includes(f.section) ? f.section : ""} onChange={(e) => e.target.value === "__new" ? setNewSec("") : setF((p) => ({ ...p, section: e.target.value }))}>
                {!secs.includes(f.section) && <option value="">{f.section}</option>}
                {secs.map((s) => <option key={s}>{s}</option>)}
                <option value="__new">New section…</option>
              </select>
            ) : (
              <input autoFocus value={newSec} onChange={(e) => setNewSec(e.target.value)} placeholder="e.g. Lighting" maxLength={30} />
            )}
          </label>
        </div>
        <label className="field"><span>Notes</span><textarea rows={2} value={f.notes} onChange={set("notes")} placeholder="Colour, size, alternatives…" /></label>
        <label className="switch"><input type="checkbox" checked={f.included} onChange={set("included")} /><span>Include in our total</span></label>
        <div className="sheet-foot">
          <button type="button" className="btn ghost danger" onClick={onRemove}>Remove</button>
          <button className="btn primary">Done</button>
        </div>
      </form>
    </Sheet>
  );
}

function RoomSheet({ room, count, onClose, onRename, onRemove }) {
  const [name, setName] = useState(room.name);
  return (
    <Sheet title="Room options" onClose={onClose}>
      <form className="form" onSubmit={(e) => { e.preventDefault(); onRename(name); }}>
        <label className="field"><span>Room name</span><input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} /></label>
        <div className="sheet-foot">
          <button type="button" className="btn ghost danger" onClick={onRemove}>
            Remove room{count ? ` and ${count} piece${count === 1 ? "" : "s"}` : ""}
          </button>
          <button className="btn primary">Save</button>
        </div>
      </form>
    </Sheet>
  );
}

function SettingsSheet({ home, onClose, onSave, onSignOut, onCopied }) {
  const [name, setName] = useState(home.name);
  return (
    <Sheet title="Settings" onClose={onClose}>
      <div className="form">
        <label className="field"><span>Home name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name.trim() && name !== home.name && onSave({ name: name.trim() })} maxLength={40} />
        </label>
        <label className="field"><span>Currency</span>
          <select value={home.currency} onChange={(e) => onSave({ currency: e.target.value })}>
            <option value="GBP">£ Pounds</option><option value="EUR">€ Euros</option><option value="USD">$ Dollars</option>
          </select>
        </label>
        <div className="field">
          <span>Invite your partner</span>
          <p className="note">They sign in with their own email, choose &ldquo;I have an invite code&rdquo; and enter:</p>
          <div className="invite">
            <strong>{home.invite_code}</strong>
            <button type="button" className="btn" onClick={() => { navigator.clipboard?.writeText(home.invite_code).then(onCopied, () => {}); }}>Copy</button>
          </div>
        </div>
        <div className="sheet-foot">
          <button type="button" className="btn ghost" onClick={onSignOut}>Sign out</button>
          <button type="button" className="btn primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </Sheet>
  );
}
