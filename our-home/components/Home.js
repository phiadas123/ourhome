"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getSupabase } from "../lib/supabaseClient";
import { findUrls, lineTotal, money, normalizeUrl, shopFromUrl, titleFromUrl, totals } from "../lib/helpers";

const newId = () =>
  typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
      });

const sectionsOf = (room) => room?.sections || [];
const strip = ({ _local, _reading, ...row }) => row;
// A piece only shows as "finding details" while it's actually being read (not forever if reading was interrupted).
const isLoading = (it) => it.status === "loading" && (it._reading || Date.now() - new Date(it.created_at).getTime() < 45000);

/* Where you are is kept in the web address, so the back button works. */
function readHash() {
  const parts = (typeof window === "undefined" ? "" : window.location.hash).replace(/^#\/?/, "").split("/").map(decodeURIComponent);
  if (parts[0] === "room" && parts[1]) return { roomId: parts[1], section: parts[2] || null };
  return { roomId: null, section: null };
}
function hashFor(roomId, section) {
  if (!roomId) return "#/";
  return `#/room/${encodeURIComponent(roomId)}${section ? "/" + encodeURIComponent(section) : ""}`;
}

export default function Home({ householdId }) {
  const sb = getSupabase();
  const [home, setHome] = useState(null);
  const [rooms, setRooms] = useState([]);
  const [items, setItems] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [place, setPlace] = useState({ roomId: null, section: null });
  const [editingId, setEditingId] = useState(null);
  const [sheet, setSheet] = useState(null); // { kind: "addRoom" | "editRoom" | "addSection" | "editSection" | "settings" }
  const [toast, setToast] = useState(null);
  const [adding, setAdding] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState(() => new Set());
  const [justAdded, setJustAdded] = useState(null);
  const toastTimer = useRef(null);
  const reloadTimer = useRef(null);
  const currency = home?.currency || "GBP";

  /* ---------- data ---------- */
  const load = useCallback(async () => {
    const [h, r, i] = await Promise.all([
      sb.from("households").select("*").eq("id", householdId).single(),
      sb.from("rooms").select("*").eq("household_id", householdId).order("position").order("created_at"),
      sb.from("items").select("*").eq("household_id", householdId).order("created_at"),
    ]);
    if (h.data) setHome(h.data);
    if (r.data) setRooms(r.data);
    if (i.data) {
      setItems((prev) => {
        const reading = new Map(prev.filter((p) => p._reading).map((p) => [p.id, p]));
        const fresh = i.data.map((d) => reading.get(d.id) || d);
        const pending = prev.filter((p) => p._local && !i.data.some((d) => d.id === p.id));
        return [...fresh, ...pending];
      });
    }
    setLoaded(true);
  }, [sb, householdId]);

  useEffect(() => {
    load();
    const schedule = () => { clearTimeout(reloadTimer.current); reloadTimer.current = setTimeout(load, 500); };
    const channel = sb
      .channel(`home-${householdId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "items", filter: `household_id=eq.${householdId}` }, schedule)
      .on("postgres_changes", { event: "*", schema: "public", table: "rooms", filter: `household_id=eq.${householdId}` }, schedule)
      .subscribe();
    window.addEventListener("focus", schedule);
    return () => { sb.removeChannel(channel); window.removeEventListener("focus", schedule); };
  }, [sb, householdId, load]);

  useEffect(() => {
    const sync = () => setPlace(readHash());
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);

  function go(roomId = null, section = null) {
    setSelecting(false); setSelected(new Set());
    const h = hashFor(roomId, section);
    if (window.location.hash !== h) window.location.hash = h;
    setPlace({ roomId, section });
    window.scrollTo({ top: 0 });
  }

  function showToast(message, undo) {
    clearTimeout(toastTimer.current);
    setToast({ message, undo, key: Date.now() });
    toastTimer.current = setTimeout(() => setToast(null), undo ? 8000 : 4000);
  }

  const room = rooms.find((r) => r.id === place.roomId) || null;
  const section = room && place.section && (sectionsOf(room).includes(place.section) || items.some((i) => i.room_id === room.id && i.section === place.section)) ? place.section : null;
  const houseItems = useMemo(() => items.filter((i) => rooms.some((r) => r.id === i.room_id)), [items, rooms]);
  const roomItems = useMemo(() => (room ? items.filter((i) => i.room_id === room.id) : []), [items, room]);
  const sectionItems = useMemo(() => (section ? roomItems.filter((i) => i.section === section) : []), [roomItems, section]);

  // If the room or section you were in no longer exists, step back up.
  useEffect(() => {
    if (!loaded) return;
    if (place.roomId && !room) go(null);
    else if (room && place.section && !section) go(room.id);
  }, [loaded, place, room, section]); // eslint-disable-line react-hooks/exhaustive-deps

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
    } catch { return null; }
  }

  async function addOne(url, targetRoom, targetSection) {
    const id = newId();
    const row = {
      id, household_id: householdId, room_id: targetRoom.id, section: targetSection,
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
      title: info?.title || row.title, shop: info?.shop || row.shop,
      image_url: info?.image || null, price: info?.price ?? null, currency: info?.currency || null,
      status: info ? (info.price != null ? "ready" : "needs_price") : "failed",
    };
    setItems((p) => p.map((x) => (x.id === id ? { ...x, ...patch, _local: false, _reading: false } : x)));
    await sb.from("items").update(patch).eq("id", id);
  }

  async function addPiece(data) {
    const id = newId();
    const row = {
      id, household_id: householdId, room_id: room.id, section,
      notes: null, included: true, created_at: new Date().toISOString(), ...data,
    };
    setAdding(false);
    setItems((p) => [...p, row]);
    setJustAdded(id);
    setTimeout(() => setJustAdded((j) => (j === id ? null : j)), 2600);
    window.scrollTo({ top: 0, behavior: "smooth" });
    const { error } = await sb.from("items").insert(row);
    if (error) { setItems((p) => p.filter((x) => x.id !== id)); showToast("That piece didn't save. Try again."); return; }
    showToast(`Added to ${section}.`);
  }

  function toggleSelect(id) {
    setSelected((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  }

  async function removeSelected() {
    const list = items.filter((i) => selected.has(i.id));
    if (!list.length) return;
    setSelecting(false); setSelected(new Set());
    setItems((p) => p.filter((x) => !list.some((l) => l.id === x.id)));
    const { error } = await sb.from("items").delete().in("id", list.map((i) => i.id));
    if (error) { showToast("Those pieces didn't delete. Try again."); load(); return; }
    showToast(`Removed ${list.length} piece${list.length === 1 ? "" : "s"}.`, async () => {
      setItems((p) => [...p, ...list.map(strip)]);
      await sb.from("items").insert(list.map(strip));
    });
  }

  async function updateItem(id, patch) {
    setItems((p) => p.map((x) => (x.id === id ? { ...x, ...patch } : x)));
    const { error } = await sb.from("items").update(patch).eq("id", id);
    if (error) { showToast("That change didn't save. Try again."); load(); }
  }

  async function refreshItem(it, newUrl) {
    const url = newUrl || it.url;
    const linkChanged = url !== it.url;
    setItems((p) => p.map((x) => (x.id === it.id ? { ...x, url, status: "loading", _reading: true } : x)));
    const info = await readLink(url);
    // A new link replaces everything; a refresh keeps what it can't find again.
    const keep = linkChanged ? { title: titleFromUrl(url) || shopFromUrl(url), shop: shopFromUrl(url), image_url: null, price: null, currency: null } : it;
    const patch = info
      ? {
          url, title: info.title || keep.title, shop: info.shop || keep.shop, image_url: info.image || keep.image_url,
          price: info.price ?? keep.price, currency: info.currency || keep.currency,
          status: (info.price ?? keep.price) != null ? "ready" : "needs_price",
        }
      : { url, ...(linkChanged ? keep : {}), status: keep.price != null ? "ready" : "failed" };
    setItems((p) => p.map((x) => (x.id === it.id ? { ...x, ...patch, _reading: false } : x)));
    await sb.from("items").update(patch).eq("id", it.id);
    showToast(info ? (linkChanged ? "Link updated." : "Details refreshed.") : "Couldn't read that page. You can add the details by hand.");
  }

  async function removeItem(it) {
    setEditingId(null);
    setItems((p) => p.filter((x) => x.id !== it.id));
    const { error } = await sb.from("items").delete().eq("id", it.id);
    if (error) { showToast("That didn't delete. Try again."); load(); return; }
    showToast(`Removed ${it.title || "piece"}.`, async () => {
      setItems((p) => [...p, strip(it)]);
      await sb.from("items").insert(strip(it));
    });
  }

  /* ---------- rooms ---------- */
  async function addRoom(name) {
    const row = { id: newId(), household_id: householdId, name, position: rooms.length, sections: [] };
    setRooms((p) => [...p, { ...row, created_at: new Date().toISOString() }]);
    setSheet(null);
    go(row.id);
    const { error } = await sb.from("rooms").insert(row);
    if (error) { showToast("That room didn't save. Try again."); load(); }
  }

  async function renameRoom(r, name) {
    setSheet(null);
    if (name === r.name) return;
    setRooms((p) => p.map((x) => (x.id === r.id ? { ...x, name } : x)));
    await sb.from("rooms").update({ name }).eq("id", r.id);
  }

  async function removeRoom(r) {
    const saved = items.filter((i) => i.room_id === r.id);
    setSheet(null);
    setRooms((p) => p.filter((x) => x.id !== r.id));
    setItems((p) => p.filter((x) => x.room_id !== r.id));
    go(null);
    const { error } = await sb.from("rooms").delete().eq("id", r.id);
    if (error) { showToast("That room didn't delete. Try again."); load(); return; }
    showToast(`Removed ${r.name}${saved.length ? ` and ${saved.length} piece${saved.length === 1 ? "" : "s"}` : ""}.`, async () => {
      const { error: e1 } = await sb.from("rooms").insert({ id: r.id, household_id: r.household_id, name: r.name, sections: r.sections, position: r.position, created_at: r.created_at });
      if (!e1 && saved.length) await sb.from("items").insert(saved.map(strip));
      await load();
    });
  }

  /* ---------- sections ---------- */
  async function addSection(r, name) {
    setSheet(null);
    const secs = sectionsOf(r);
    const existing = secs.find((s) => s.toLowerCase() === name.toLowerCase());
    if (existing) { go(r.id, existing); return; }
    const next = [...secs, name];
    setRooms((p) => p.map((x) => (x.id === r.id ? { ...x, sections: next } : x)));
    go(r.id, name);
    const { error } = await sb.from("rooms").update({ sections: next }).eq("id", r.id);
    if (error) { showToast("That section didn't save. Try again."); load(); }
  }

  async function renameSection(r, oldName, name) {
    setSheet(null);
    if (name === oldName) return;
    if (sectionsOf(r).some((s) => s !== oldName && s.toLowerCase() === name.toLowerCase())) {
      showToast(`${r.name} already has a section called ${name}.`);
      return;
    }
    const next = sectionsOf(r).map((s) => (s === oldName ? name : s));
    setRooms((p) => p.map((x) => (x.id === r.id ? { ...x, sections: next } : x)));
    setItems((p) => p.map((x) => (x.room_id === r.id && x.section === oldName ? { ...x, section: name } : x)));
    go(r.id, name);
    await sb.from("rooms").update({ sections: next }).eq("id", r.id);
    await sb.from("items").update({ section: name }).eq("room_id", r.id).eq("section", oldName);
  }

  async function removeSection(r, name) {
    const saved = items.filter((i) => i.room_id === r.id && i.section === name);
    const before = sectionsOf(r);
    const next = before.filter((s) => s !== name);
    setSheet(null);
    setRooms((p) => p.map((x) => (x.id === r.id ? { ...x, sections: next } : x)));
    setItems((p) => p.filter((x) => !(x.room_id === r.id && x.section === name)));
    go(r.id);
    await sb.from("rooms").update({ sections: next }).eq("id", r.id);
    if (saved.length) await sb.from("items").delete().eq("room_id", r.id).eq("section", name);
    showToast(`Removed ${name}${saved.length ? ` and ${saved.length} piece${saved.length === 1 ? "" : "s"}` : ""}.`, async () => {
      await sb.from("rooms").update({ sections: before }).eq("id", r.id);
      if (saved.length) await sb.from("items").insert(saved.map(strip));
      await load();
    });
  }

  async function saveHome(patch) {
    setHome((h) => ({ ...h, ...patch }));
    await sb.from("households").update(patch).eq("id", householdId);
  }

  const editing = items.find((i) => i.id === editingId) || null;
  const house = totals(houseItems);
  const roomT = totals(roomItems);

  return (
    <>
      <header className="top">
        <button className="brand" onClick={() => go(null)}>{home?.name || "Our home"}</button>
        <button className="btn ghost" onClick={() => setSheet({ kind: "settings" })}>Settings</button>
      </header>

      {room && (
        <nav className="crumbs" aria-label="You are here">
          <button onClick={() => go(null)}>{home?.name || "Our home"}</button>
          <span aria-hidden="true">/</span>
          {section ? <button onClick={() => go(room.id)}>{room.name}</button> : <span className="here">{room.name}</span>}
          {section && <><span aria-hidden="true">/</span><span className="here">{section}</span></>}
        </nav>
      )}

      <main className="page">
        {!loaded ? (
          <p className="quiet">Opening your home…</p>
        ) : !room ? (
          <HouseView
            home={home} rooms={rooms} items={houseItems} currency={currency}
            onOpen={(id) => go(id)} onAddRoom={() => setSheet({ kind: "addRoom" })}
          />
        ) : !section ? (
          <RoomView
            room={room} items={roomItems} currency={currency}
            onOpen={(s) => go(room.id, s)}
            onAddSection={() => setSheet({ kind: "addSection" })}
            onEditRoom={() => setSheet({ kind: "editRoom" })}
          />
        ) : (
          <SectionView
            room={room} section={section} items={sectionItems} currency={currency}
            selecting={selecting} selected={selected} justAdded={justAdded}
            onStartAdd={() => setAdding(true)}
            onStartSelect={() => { setSelecting(true); setSelected(new Set()); }}
            onSelect={toggleSelect}
            onEdit={setEditingId}
            onToggle={(it) => updateItem(it.id, { included: !(it.included !== false) })}
            onRemove={removeItem}
            onEditSection={() => setSheet({ kind: "editSection" })}
          />
        )}
      </main>

      {selecting ? (
        <footer className="tally select-bar" aria-live="polite">
          <span className="select-count">{selected.size ? `${selected.size} selected` : "Tap pieces to select them"}</span>
          <button className="btn ghost" onClick={() => setSelected(selected.size === sectionItems.length ? new Set() : new Set(sectionItems.map((i) => i.id)))}>
            {selected.size === sectionItems.length && sectionItems.length ? "Clear" : "Select all"}
          </button>
          <span className="select-spacer" />
          <button className="btn" onClick={() => { setSelecting(false); setSelected(new Set()); }}>Cancel</button>
          <button className="btn primary danger-fill" disabled={!selected.size} onClick={removeSelected}>Delete{selected.size ? ` ${selected.size}` : ""}</button>
        </footer>
      ) : (
      <footer className="tally" aria-live="polite">
        <div className="tally-block">
          <span className="tally-label">Whole house</span>
          <span className="tally-big">{money(house.included, currency)}</span>
        </div>
        {room ? (
          <div className="tally-block tally-room">
            <span className="tally-label">{room.name}</span>
            <span className="tally-mid">{money(roomT.included, currency)}</span>
          </div>
        ) : (
          <div className="tally-side">
            {house.count
              ? <>{house.includedCount} of {house.count} pieces included<br /><span>{money(house.all, currency)} if you bought everything</span></>
              : "Totals appear as you add pieces"}
          </div>
        )}
      </footer>
      )}

      {adding && room && section && (
        <AddSheet where={section} currency={currency} readLink={readLink}
          onClose={() => setAdding(false)} onAdd={addPiece}
          onAddMany={(urls) => { setAdding(false); urls.forEach((u) => addOne(u, room, section)); showToast(`Adding ${urls.length} pieces…`); }} />
      )}

      {editing && (
        <EditSheet
          key={editing.id} item={editing} rooms={rooms} currency={currency}
          onClose={() => setEditingId(null)}
          onSave={(patch, newUrl) => {
            const it = editing;
            setEditingId(null);
            updateItem(it.id, patch).then(() => { if (newUrl) refreshItem({ ...it, ...patch }, newUrl); });
          }}
          onRefresh={() => refreshItem(editing)}
          onRemove={() => removeItem(editing)}
        />
      )}

      {sheet?.kind === "addRoom" && (
        <NameSheet title="Add a room" label="Room name" placeholder="e.g. Living room" action="Add room"
          onClose={() => setSheet(null)} onSave={addRoom} />
      )}
      {sheet?.kind === "editRoom" && room && (
        <NameSheet title="Edit room" label="Room name" initial={room.name} action="Save"
          onClose={() => setSheet(null)} onSave={(n) => renameRoom(room, n)}
          removeLabel={`Remove room${roomItems.length ? ` and ${roomItems.length} piece${roomItems.length === 1 ? "" : "s"}` : ""}`}
          onRemove={() => removeRoom(room)} />
      )}
      {sheet?.kind === "addSection" && room && (
        <NameSheet title={`Add a section to ${room.name}`} label="Section name" placeholder="e.g. Storage" action="Add section"
          suggestions={["Furniture", "Appliances", "Storage", "Decor", "Lighting", "Textiles"].filter((s) => !sectionsOf(room).includes(s))}
          onClose={() => setSheet(null)} onSave={(n) => addSection(room, n)} />
      )}
      {sheet?.kind === "editSection" && room && section && (
        <NameSheet title="Edit section" label="Section name" initial={section} action="Save"
          onClose={() => setSheet(null)} onSave={(n) => renameSection(room, section, n)}
          removeLabel={`Remove section${sectionItems.length ? ` and ${sectionItems.length} piece${sectionItems.length === 1 ? "" : "s"}` : ""}`}
          onRemove={() => removeSection(room, section)} />
      )}
      {sheet?.kind === "settings" && home && (
        <SettingsSheet home={home} onClose={() => setSheet(null)} onSave={saveHome}
          onCopied={() => showToast("Invite code copied.")} />
      )}

      {toast && (
        <div className="toast" key={toast.key} role="status">
          <span>{toast.message}</span>
          {toast.undo && <button onClick={() => { const u = toast.undo; setToast(null); u(); }}>Undo</button>}
        </div>
      )}
    </>
  );
}

/* ---------- views ---------- */

function HouseView({ home, rooms, items, currency, onOpen, onAddRoom }) {
  const t = totals(items);
  if (!rooms.length) {
    return (
      <div className="empty">
        <h1 className="room-title">Begin with a room.</h1>
        <p className="empty-note">Add the first room you&rsquo;re furnishing. Inside it, you&rsquo;ll create sections like Storage or Decor and paste in links to everything you love.</p>
        <button className="btn primary" onClick={onAddRoom}>Add a room</button>
      </div>
    );
  }
  const max = Math.max(1, ...rooms.map((r) => totals(items.filter((i) => i.room_id === r.id)).included));
  return (
    <>
      <div className="room-head">
        <div>
          <h1 className="room-title">{home?.name || "Our home"}</h1>
          <p className="room-sub">{t.count ? `${money(t.included, currency)} across ${rooms.length} room${rooms.length === 1 ? "" : "s"}` : `${rooms.length} room${rooms.length === 1 ? "" : "s"}`}</p>
        </div>
      </div>
      <div className="ov">
        {rooms.map((r) => {
          const rt = totals(items.filter((i) => i.room_id === r.id));
          const secCount = r.sections?.length || 0;
          return (
            <button key={r.id} className="ov-row" onClick={() => onOpen(r.id)}>
              <span className="ov-name">{r.name}<small>{secCount} section{secCount === 1 ? "" : "s"} · {rt.count} piece{rt.count === 1 ? "" : "s"}</small></span>
              <span className="ov-bar"><span style={{ width: `${(rt.included / max) * 100}%` }} /></span>
              <span className="ov-val">{money(rt.included, currency)}</span>
            </button>
          );
        })}
        <button className="ov-row add" onClick={onAddRoom}><span className="ov-name">+ Add a room</span></button>
      </div>
    </>
  );
}

function RoomView({ room, items, currency, onOpen, onAddSection, onEditRoom }) {
  const t = totals(items);
  const names = [...sectionsOf(room), ...new Set(items.map((i) => i.section).filter((s) => !sectionsOf(room).includes(s)))];
  return (
    <>
      <div className="room-head">
        <div>
          <h1 className="room-title">{room.name}</h1>
          <p className="room-sub">{t.count ? `${money(t.included, currency)} across ${t.includedCount} of ${t.count} piece${t.count === 1 ? "" : "s"}` : "No pieces yet"}</p>
        </div>
        <button className="btn" onClick={onEditRoom}>Edit room</button>
      </div>
      {!names.length && (
        <p className="empty-note">Add a section to start, for example Furniture, Storage or Decor. Then open it and paste in your links.</p>
      )}
      <div className="tiles">
        {names.map((s) => {
          const list = items.filter((i) => i.section === s);
          const st = totals(list);
          const pics = list.filter((i) => i.image_url).slice(0, 4);
          return (
            <button key={s} className="tile" onClick={() => onOpen(s)}>
              <span className={`collage n${pics.length}`}>
                {pics.map((p) => (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img key={p.id} src={p.image_url} alt="" loading="lazy" referrerPolicy="no-referrer" onError={(e) => { e.currentTarget.style.display = "none"; }} />
                ))}
                {!pics.length && <span className="collage-blank">{s.charAt(0).toUpperCase()}</span>}
              </span>
              <span className="tile-name">{s}</span>
              <span className="tile-meta">{list.length ? `${money(st.included, currency)} · ${list.length} piece${list.length === 1 ? "" : "s"}` : "Empty"}</span>
            </button>
          );
        })}
        <button className="tile add" onClick={onAddSection}>
          <span className="collage add-box"><span>+</span></span>
          <span className="tile-name">Add a section</span>
          <span className="tile-meta">e.g. Storage, Decor</span>
        </button>
      </div>
    </>
  );
}

function SectionView({ room, section, items, currency, selecting, selected, justAdded, onStartAdd, onEdit, onToggle, onRemove, onEditSection, onStartSelect, onSelect }) {
  const t = totals(items);
  const sorted = [...items].sort((x, y) => new Date(y.created_at) - new Date(x.created_at));
  return (
    <>
      <div className="room-head">
        <div>
          <h1 className="room-title">{section}</h1>
          <p className="room-sub">{t.count ? `${money(t.included, currency)} across ${t.includedCount} of ${t.count} piece${t.count === 1 ? "" : "s"}` : `In ${room.name}`}</p>
        </div>
        <div className="head-actions">
          {items.length > 0 && !selecting && <button className="btn" onClick={onStartSelect}>Select</button>}
          <button className="btn" onClick={onEditSection}>Edit section</button>
        </div>
      </div>
      {!selecting && (
        <button className="add-bar" onClick={onStartAdd}>
          <span className="add-plus" aria-hidden="true">+</span>
          <span>Add a piece</span>
          <small>Paste a product link</small>
        </button>
      )}
      {!items.length && <p className="empty-note">Tap Add a piece, paste a link from any shop, and you&rsquo;ll see the photo, name and price before you save it.</p>}
      <div className="grid">
        {sorted.map((it) => (
          <Card key={it.id} item={it} currency={currency} fresh={justAdded === it.id}
            selecting={selecting} selected={selected.has(it.id)} onSelect={() => onSelect(it.id)}
            onEdit={() => onEdit(it.id)} onToggle={() => onToggle(it)} onRemove={() => onRemove(it)} />
        ))}
      </div>
    </>
  );
}

/* ---------- pieces ---------- */

function AddSheet({ where, currency, readLink, onClose, onAdd, onAddMany }) {
  const [step, setStep] = useState("link");
  const [link, setLink] = useState("");
  const [error, setError] = useState("");
  const [many, setMany] = useState([]);
  const [readUrl, setReadUrl] = useState(null);
  const [reading, setReading] = useState(false);
  const [readFailed, setReadFailed] = useState(false);
  const [imgFailed, setImgFailed] = useState(false);
  const [showPhoto, setShowPhoto] = useState(false);
  const [f, setF] = useState({ title: "", shop: "", price: "", qty: 1, image: "", currency: null });
  const req = useRef(0);

  async function read(raw) {
    const urls = findUrls(raw);
    if (!urls.length) { setError("That doesn't look like a link. Copy the web address from the shop's product page."); return; }
    if (urls.length > 1) { setMany(urls); setError(""); return; }
    const url = urls[0];
    const id = ++req.current;
    setLink(url); setReadUrl(url); setError(""); setMany([]); setStep("review");
    setReading(true); setReadFailed(false); setImgFailed(false);
    const info = await readLink(url);
    if (id !== req.current) return;
    setReading(false);
    setF({
      title: info?.title || titleFromUrl(url) || shopFromUrl(url),
      shop: info?.shop || shopFromUrl(url),
      price: info?.price ?? "",
      qty: 1,
      image: info?.image || "",
      currency: info?.currency || null,
    });
    if (!info || (!info.image && info.price == null)) setReadFailed(true);
  }

  const cleanLink = normalizeUrl(link);
  const linkChanged = step === "review" && cleanLink && cleanLink !== readUrl;

  function submit(e) {
    e.preventDefault();
    if (step === "link" || linkChanged) { read(link); return; }
    if (reading) return;
    const price = f.price === "" ? null : Math.max(0, Number(f.price));
    onAdd({
      url: readUrl,
      title: f.title.trim() || titleFromUrl(readUrl) || shopFromUrl(readUrl),
      shop: f.shop, image_url: f.image.trim() ? normalizeUrl(f.image) : null,
      price, currency: f.currency, qty: Math.max(1, parseInt(f.qty, 10) || 1),
      status: price != null ? "ready" : "needs_price",
    });
  }

  const set = (k) => (e) => setF((p) => ({ ...p, [k]: e.target.value }));

  return (
    <Sheet title={`Add to ${where}`} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label className="field"><span>Product link</span>
          <input
            type="url" inputMode="url" autoFocus={step === "link"} value={link}
            placeholder="Paste the link from the shop's page"
            onChange={(e) => { setLink(e.target.value); setError(""); setMany([]); }}
            onPaste={(e) => { const t = e.clipboardData.getData("text"); if (findUrls(t).length) { e.preventDefault(); setLink(t.trim()); read(t); } }}
          />
          {error && <small className="field-hint error">{error}</small>}
          {linkChanged && <small className="field-hint">You&rsquo;ve changed the link. Press &ldquo;Find product&rdquo; to read it.</small>}
        </label>

        {many.length > 0 && (
          <div className="many">
            <p className="note">That&rsquo;s {many.length} links. Add them all at once? Each piece&rsquo;s photo and price will fill in after it&rsquo;s added.</p>
            <button type="button" className="btn primary" onClick={() => onAddMany(many)}>Add all {many.length}</button>
          </div>
        )}

        {step === "review" && (
          <>
            <div className="preview">
              <div className={`preview-img${reading ? " loading" : ""}`}>
                {!reading && f.image && !imgFailed
                  // eslint-disable-next-line @next/next/no-img-element
                  ? <img src={f.image} alt="" referrerPolicy="no-referrer" onError={() => setImgFailed(true)} />
                  : !reading && <span>{(f.title || "?").charAt(0).toUpperCase()}</span>}
              </div>
              <div className="preview-text">
                {reading ? (
                  <p className="preview-status">Finding the photo, name and price…</p>
                ) : (
                  <>
                    <p className="card-shop">{f.shop}</p>
                    <p className="preview-title">{f.title || "Untitled"}</p>
                    <p className="preview-price">{f.price !== "" ? money(f.price, f.currency || currency) : "No price found"}</p>
                    <button type="button" className="link" onClick={() => setShowPhoto((v) => !v)}>{showPhoto ? "Hide photo link" : "Wrong photo?"}</button>
                  </>
                )}
              </div>
            </div>
            {!reading && readFailed && <p className="note">This shop didn&rsquo;t share all its details. Fill in anything missing below.</p>}
            {!reading && (
              <>
                {showPhoto && (
                  <label className="field"><span>Photo link</span>
                    <input type="url" inputMode="url" value={f.image} onChange={(e) => { set("image")(e); setImgFailed(false); }} placeholder="Paste an image address" />
                    <small className="field-hint">On the shop&rsquo;s page, right-click (or press and hold) the product photo, choose &ldquo;Copy image address&rdquo; and paste it here.</small>
                  </label>
                )}
                <label className="field"><span>Name</span><input value={f.title} onChange={set("title")} /></label>
                <div className="row">
                  <label className="field"><span>Price each ({f.currency || currency})</span>
                    <input type="number" inputMode="decimal" min="0" step="0.01" value={f.price} onChange={set("price")} placeholder="0" />
                  </label>
                  <label className="field"><span>Quantity</span><input type="number" min="1" step="1" value={f.qty} onChange={set("qty")} /></label>
                </div>
              </>
            )}
          </>
        )}

        <div className="sheet-foot">
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          {step === "link" || linkChanged
            ? <button className="btn primary" disabled={!link.trim()}>Find product</button>
            : <button className="btn primary" disabled={reading}>{reading ? "Reading…" : "Add piece"}</button>}
        </div>
      </form>
    </Sheet>
  );
}

function Card({ item, currency, fresh, selecting, selected, onSelect, onEdit, onToggle, onRemove }) {
  const [imgFailed, setImgFailed] = useState(false);
  const included = item.included !== false;
  const loading = isLoading(item);
  const q = Math.max(1, Number(item.qty) || 1);
  const hasPrice = item.price != null && Number(item.price) > 0;
  const cur = item.currency || currency;
  return (
    <article className={`card${included ? "" : " off"}${loading ? " loading" : ""}${fresh ? " fresh" : ""}${selecting ? " selecting" : ""}${selected ? " selected" : ""}`}>
      {selecting && (
        <button className="select-cover" onClick={onSelect} aria-pressed={selected} aria-label={`${selected ? "Deselect" : "Select"} ${item.title}`}>
          <span className="select-dot"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.6" /></svg></span>
        </button>
      )}
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
        {!loading && !selecting && (
          <button className={`check${included ? " on" : ""}`} onClick={onToggle} aria-pressed={included}
            aria-label={included ? "Included in total. Tap to set aside" : "Set aside. Tap to include"}>
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.6" /></svg>
          </button>
        )}
      </div>
      <button className="card-body" onClick={onEdit}>
        <span className="card-shop">{item.shop}</span>
        <span className="card-title">{item.title || "Untitled"}</span>
        <span className={`card-price${hasPrice ? "" : " none"}`}>
          {loading ? "\u00a0" : hasPrice ? <>{money(lineTotal(item), cur)}{q > 1 && <small> {q} × {money(item.price, cur)}</small>}</> : "Add price"}
        </span>
      </button>
      {!selecting && (
        <div className="card-actions">
          <button onClick={onEdit}>Edit</button>
          <button onClick={onRemove}>Remove</button>
        </div>
      )}
    </article>
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

function NameSheet({ title, label, initial = "", placeholder, action, suggestions, onClose, onSave, removeLabel, onRemove }) {
  const [name, setName] = useState(initial);
  const submit = (n) => { const clean = (n ?? name).trim(); if (clean) onSave(clean.slice(0, 40)); };
  return (
    <Sheet title={title} onClose={onClose}>
      <form className="form" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <label className="field"><span>{label}</span>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={placeholder} maxLength={40} />
        </label>
        {suggestions?.length > 0 && (
          <div className="chips">
            {suggestions.map((s) => <button type="button" key={s} className="chip" onClick={() => submit(s)}>{s}</button>)}
          </div>
        )}
        <div className="sheet-foot">
          {onRemove ? <button type="button" className="btn ghost danger" onClick={onRemove}>{removeLabel}</button> : <span />}
          <button className="btn primary" disabled={!name.trim()}>{action}</button>
        </div>
      </form>
    </Sheet>
  );
}

function EditSheet({ item, rooms, currency, onClose, onSave, onRefresh, onRemove }) {
  const [link, setLink] = useState(item.url);
  const [photo, setPhoto] = useState(item.image_url || "");
  const [linkError, setLinkError] = useState("");
  const movable = rooms.filter((r) => sectionsOf(r).length || r.id === item.room_id);
  const [f, setF] = useState({
    title: item.title || "", price: item.price ?? "", qty: item.qty || 1, room_id: item.room_id,
    section: item.section, notes: item.notes || "", included: item.included !== false,
  });
  const room = rooms.find((r) => r.id === f.room_id);
  const secs = [...new Set([...sectionsOf(room), ...(f.room_id === item.room_id ? [item.section] : [])])];
  const set = (k) => (e) => setF((p) => ({ ...p, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  const loading = isLoading(item);

  function save(e) {
    e.preventDefault();
    const cleanLink = normalizeUrl(link);
    if (!cleanLink) { setLinkError("Enter the full web address, starting with https://"); return; }
    const newUrl = cleanLink !== item.url ? cleanLink : null;
    const cleanPhoto = photo.trim() ? normalizeUrl(photo) : null;
    onSave({
      image_url: cleanPhoto,
      title: f.title.trim() || item.title,
      price: f.price === "" ? null : Math.max(0, Number(f.price)),
      qty: Math.max(1, parseInt(f.qty, 10) || 1),
      room_id: f.room_id, section: secs.includes(f.section) ? f.section : secs[0],
      notes: f.notes.trim() || null, included: f.included,
      status: f.price === "" ? (item.status === "failed" ? "failed" : "needs_price") : "ready",
    }, newUrl);
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
            <button type="button" className="link" onClick={onRefresh} disabled={loading}>{loading ? "Refreshing…" : "Refresh photo and price"}</button>
          </div>
        </div>
        {item.status === "failed" && <p className="note">This shop didn&rsquo;t share its details. Add the name and price below.</p>}
        <label className="field"><span>Product link</span>
          <input type="url" inputMode="url" value={link} onChange={(e) => { setLink(e.target.value); setLinkError(""); }} />
          {normalizeUrl(link) && normalizeUrl(link) !== item.url
            ? <small className="field-hint">When you press Done, the photo, name and price will be read again from this link.</small>
            : linkError ? <small className="field-hint error">{linkError}</small> : null}
        </label>
        <label className="field"><span>Name</span><input value={f.title} onChange={set("title")} /></label>
        <div className="row">
          <label className="field"><span>Price each ({item.currency || currency})</span>
            <input type="number" inputMode="decimal" min="0" step="0.01" value={f.price} onChange={set("price")} placeholder="0" autoFocus={item.price == null} />
          </label>
          <label className="field"><span>Quantity</span><input type="number" min="1" step="1" value={f.qty} onChange={set("qty")} /></label>
        </div>
        <div className="row">
          <label className="field"><span>Room</span>
            <select value={f.room_id} onChange={(e) => {
              const r = rooms.find((x) => x.id === e.target.value);
              setF((p) => ({ ...p, room_id: e.target.value, section: sectionsOf(r).includes(p.section) ? p.section : sectionsOf(r)[0] }));
            }}>
              {movable.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </label>
          <label className="field"><span>Section</span>
            <select value={f.section} onChange={set("section")}>
              {secs.map((s) => <option key={s}>{s}</option>)}
            </select>
          </label>
        </div>
        <label className="field"><span>Notes</span><textarea rows={2} value={f.notes} onChange={set("notes")} placeholder="Colour, size, alternatives…" /></label>
        <label className="field"><span>Photo link</span>
          <input type="url" inputMode="url" value={photo} onChange={(e) => setPhoto(e.target.value)} placeholder="Paste an image address to use a different photo" />
          <small className="field-hint">Wrong photo? On the shop&rsquo;s page, right-click (or press and hold) the product photo, choose &ldquo;Copy image address&rdquo; and paste it here.</small>
        </label>
        <label className="switch"><input type="checkbox" checked={f.included} onChange={set("included")} /><span>Include in our total</span></label>
        <div className="sheet-foot">
          <button type="button" className="btn ghost danger" onClick={onRemove}>Remove</button>
          <button className="btn primary">Done</button>
        </div>
      </form>
    </Sheet>
  );
}

function SettingsSheet({ home, onClose, onSave, onCopied }) {
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
          <span>Invite code</span>
          <p className="note">To open your home on another phone or laptop, or to share it with your partner, open the site there, choose &ldquo;I have an invite code&rdquo; and enter:</p>
          <div className="invite">
            <strong>{home.invite_code}</strong>
            <button type="button" className="btn" onClick={() => { navigator.clipboard?.writeText(home.invite_code).then(onCopied, () => {}); }}>Copy</button>
          </div>
        </div>
        <div className="sheet-foot">
          <span />
          <button type="button" className="btn primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </Sheet>
  );
}
