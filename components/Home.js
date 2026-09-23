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


async function shrinkImage(file) {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 1400 / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext("2d").drawImage(bmp, 0, 0, canvas.width, canvas.height);
    return await new Promise((res) => canvas.toBlob((b) => res(b || file), "image/jpeg", 0.85));
  } catch {
    return file;
  }
}

/* The page you're on lives in the web address, so the back button works. */
const roomFromHash = () => {
  if (typeof window === "undefined") return null;
  const m = window.location.hash.match(/^#\/room\/([^/]+)/);
  return m ? decodeURIComponent(m[1]) : null;
};

export default function Home({ householdId }) {
  const sb = getSupabase();
  const [home, setHome] = useState(null);
  const [rooms, setRooms] = useState([]);
  const [items, setItems] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [sheet, setSheet] = useState(null); // { kind, roomId, section }
  const [adding, setAdding] = useState(null); // { roomId, section }
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState(() => new Set());
  const [justAdded, setJustAdded] = useState(null);
  const [roomView, setRoomView] = useState(null);
  const [toast, setToast] = useState(null);
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
    const sync = () => setRoomView(roomFromHash());
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);

  function openRoom(id) {
    const h = id ? `#/room/${encodeURIComponent(id)}` : "#/";
    if (window.location.hash !== h) window.location.hash = h;
    setRoomView(id);
    setSelecting(false); setSelected(new Set());
    window.scrollTo({ top: 0 });
  }

  function showToast(message, undo) {
    clearTimeout(toastTimer.current);
    setToast({ message, undo, key: Date.now() });
    toastTimer.current = setTimeout(() => setToast(null), undo ? 8000 : 4000);
  }

  function scrollToId(id) {
    setTimeout(() => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "center" }), 80);
  }

  const houseItems = useMemo(() => items.filter((i) => rooms.some((r) => r.id === i.room_id)), [items, rooms]);
  const roomById = (id) => rooms.find((r) => r.id === id) || null;

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

  // Photos you upload are shrunk on your device first, then stored in Supabase.
  async function uploadPhoto(file) {
    const blob = await shrinkImage(file);
    const path = `${householdId}/${newId()}.jpg`;
    const { error } = await sb.storage.from("photos").upload(path, blob, { contentType: blob.type || "image/jpeg", upsert: false });
    if (error) throw error;
    return sb.storage.from("photos").getPublicUrl(path).data.publicUrl;
  }

  async function addPiece(data, target) {
    const id = newId();
    const row = {
      id, household_id: householdId, room_id: target.roomId, section: target.section,
      notes: null, included: true, created_at: new Date().toISOString(), ...data,
    };
    setAdding(null);
    setItems((p) => [...p, row]);
    setJustAdded(id);
    scrollToId(`piece-${id}`);
    setTimeout(() => setJustAdded((j) => (j === id ? null : j)), 2600);
    const { error } = await sb.from("items").insert(row);
    if (error) { setItems((p) => p.filter((x) => x.id !== id)); showToast("That piece didn't save. Try again."); return; }
    showToast(`Added to ${target.section}.`);
  }

  async function addFromLink(url, target) {
    const id = newId();
    const row = {
      id, household_id: householdId, room_id: target.roomId, section: target.section,
      url, title: titleFromUrl(url) || shopFromUrl(url), shop: shopFromUrl(url),
      image_url: null, price: null, currency: null, qty: 1, included: true, notes: null,
      status: "loading", created_at: new Date().toISOString(),
    };
    setItems((p) => [...p, { ...row, _local: true, _reading: true }]);
    const { error } = await sb.from("items").insert(row);
    if (error) { setItems((p) => p.filter((x) => x.id !== id)); showToast("A link didn't save. Try again."); return; }
    const info = await readLink(url);
    const patch = {
      title: info?.title || row.title, shop: info?.shop || row.shop,
      image_url: info?.image || null, price: info?.price ?? null, currency: info?.currency || null,
      status: info ? (info.price != null ? "ready" : "needs_price") : "failed",
    };
    setItems((p) => p.map((x) => (x.id === id ? { ...x, ...patch, _local: false, _reading: false } : x)));
    await sb.from("items").update(patch).eq("id", id);
  }

  async function updateItem(id, patch) {
    setItems((p) => p.map((x) => (x.id === id ? { ...x, ...patch } : x)));
    const { error } = await sb.from("items").update(patch).eq("id", id);
    if (error) { showToast("That change didn't save. Try again."); load(); }
  }

  async function refreshItem(it, newUrl, keepPhoto = false) {
    const url = newUrl || it.url;
    const linkChanged = url !== it.url;
    setItems((p) => p.map((x) => (x.id === it.id ? { ...x, url, status: "loading", _reading: true } : x)));
    const info = await readLink(url);
    const keep = linkChanged ? { title: titleFromUrl(url) || shopFromUrl(url), shop: shopFromUrl(url), image_url: null, price: null, currency: null } : it;
    const patch = info
      ? {
          url, title: info.title || keep.title, shop: info.shop || keep.shop, image_url: keepPhoto ? it.image_url : info.image || keep.image_url,
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

  function toggleSelect(id) {
    setSelected((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  }
  function stopSelecting() { setSelecting(false); setSelected(new Set()); }

  async function removeSelected() {
    const list = items.filter((i) => selected.has(i.id));
    if (!list.length) return;
    stopSelecting();
    setItems((p) => p.filter((x) => !selected.has(x.id)));
    const { error } = await sb.from("items").delete().in("id", list.map((i) => i.id));
    if (error) { showToast("Those pieces didn't delete. Try again."); load(); return; }
    showToast(`Removed ${list.length} piece${list.length === 1 ? "" : "s"}.`, async () => {
      setItems((p) => [...p, ...list.map(strip)]);
      await sb.from("items").insert(list.map(strip));
    });
  }

  /* ---------- rooms ---------- */
  async function addRoom(name) {
    const row = { id: newId(), household_id: householdId, name, position: rooms.length, sections: [] };
    setRooms((p) => [...p, { ...row, created_at: new Date().toISOString() }]);
    setSheet(null);
    openRoom(row.id);
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
    if (roomView === r.id) openRoom(null);
    const { error } = await sb.from("rooms").delete().eq("id", r.id);
    if (error) { showToast("That room didn't delete. Try again."); load(); return; }
    showToast(`Removed ${r.name}${saved.length ? ` and ${saved.length} piece${saved.length === 1 ? "" : "s"}` : ""}.`, async () => {
      const { error: e1 } = await sb.from("rooms").insert({ id: r.id, household_id: r.household_id, name: r.name, sections: r.sections, position: r.position, created_at: r.created_at });
      if (!e1 && saved.length) await sb.from("items").insert(saved.map(strip));
      await load();
    });
  }

  /* ---------- sections ---------- */
  const secKey = (roomId, name) => `sec-${roomId}-${name.replace(/[^a-z0-9]+/gi, "-")}`;

  async function addSection(r, name) {
    setSheet(null);
    const secs = sectionsOf(r);
    const existing = secs.find((s) => s.toLowerCase() === name.toLowerCase());
    if (existing) { scrollToId(secKey(r.id, existing)); return; }
    const next = [...secs, name];
    setRooms((p) => p.map((x) => (x.id === r.id ? { ...x, sections: next } : x)));
    scrollToId(secKey(r.id, name));
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
    const next = sectionsOf(r).includes(oldName) ? sectionsOf(r).map((s) => (s === oldName ? name : s)) : [...sectionsOf(r), name];
    setRooms((p) => p.map((x) => (x.id === r.id ? { ...x, sections: next } : x)));
    setItems((p) => p.map((x) => (x.room_id === r.id && x.section === oldName ? { ...x, section: name } : x)));
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
  const current = roomView ? roomById(roomView) : null;
  const shownRooms = current ? [current] : rooms;
  const currentT = current ? totals(items.filter((i) => i.room_id === current.id)) : null;
  const sheetRoom = sheet?.roomId ? roomById(sheet.roomId) : null;
  const sheetRoomItems = sheetRoom ? items.filter((i) => i.room_id === sheetRoom.id) : [];
  const sheetSectionItems = sheet?.section ? sheetRoomItems.filter((i) => i.section === sheet.section) : [];

  return (
    <>
      <header className="top">
        <div className="brand">{home?.name || "Our home"}</div>
        <div className="top-actions">
          {houseItems.length > 0 && !selecting && <button className="btn ghost" onClick={() => { setSelecting(true); setSelected(new Set()); }}>Select</button>}
          <button className="btn ghost" onClick={() => setSheet({ kind: "settings" })}>Settings</button>
        </div>
      </header>

      {rooms.length > 0 && (
        <nav className="jump" aria-label="Rooms">
          <div className="jump-inner">
            <button aria-current={!current} onClick={() => openRoom(null)}>Whole home</button>
            {rooms.map((r) => (
              <button key={r.id} aria-current={current?.id === r.id} onClick={() => openRoom(r.id)}>{r.name}</button>
            ))}
            <button className="jump-add" onClick={() => setSheet({ kind: "addRoom" })}>+ Room</button>
          </div>
        </nav>
      )}

      <main className="page">
        {!loaded ? (
          <p className="quiet">Opening your home…</p>
        ) : !rooms.length ? (
          <div className="empty">
            <h1 className="room-title">Begin with a room.</h1>
            <p className="empty-note">Add the first room you&rsquo;re furnishing. Then add sections like Storage or Decor, and paste links to everything you love.</p>
            <button className="btn primary" onClick={() => setSheet({ kind: "addRoom" })}>Add a room</button>
          </div>
        ) : (
          <>
            {shownRooms.map((r) => (
              <RoomBlock
                key={r.id} room={r} single={!!current} onOpen={() => openRoom(r.id)} items={items.filter((i) => i.room_id === r.id)} currency={currency}
                selecting={selecting} selected={selected} justAdded={justAdded} secKey={secKey}
                onEditRoom={() => setSheet({ kind: "editRoom", roomId: r.id })}
                onAddSection={() => setSheet({ kind: "addSection", roomId: r.id })}
                onEditSection={(s) => setSheet({ kind: "editSection", roomId: r.id, section: s })}
                onAdd={(s) => setAdding({ roomId: r.id, section: s })}
                onSelect={toggleSelect}
                onEdit={setEditingId}
                onToggle={(it) => updateItem(it.id, { included: !(it.included !== false) })}
                onRemove={removeItem}
              />
            ))}
            {!current && <button className="add-room" onClick={() => setSheet({ kind: "addRoom" })}>+ Add a room</button>}
          </>
        )}
      </main>

      {selecting ? (
        <footer className="tally select-bar" aria-live="polite">
          <span className="select-count">{selected.size ? `${selected.size} selected` : "Tap pieces to select them"}</span>
          <span className="select-spacer" />
          <button className="btn" onClick={stopSelecting}>Cancel</button>
          <button className="btn primary danger-fill" disabled={!selected.size} onClick={removeSelected}>Delete{selected.size ? ` ${selected.size}` : ""}</button>
        </footer>
      ) : (
        <footer className="tally" aria-live="polite">
          <div className="tally-block">
            <span className="tally-label">Whole house</span>
            <span className="tally-big">{money(house.included, currency)}</span>
          </div>
          {current ? (
            <div className="tally-block tally-room">
              <span className="tally-label">{current.name}</span>
              <span className="tally-mid">{money(currentT.included, currency)}</span>
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

      {adding && roomById(adding.roomId) && (
        <AddSheet where={adding.section} currency={currency} readLink={readLink} onUpload={uploadPhoto}
          onClose={() => setAdding(null)} onAdd={(d) => addPiece(d, adding)}
          onAddMany={(urls) => { const t = adding; setAdding(null); urls.forEach((u) => addFromLink(u, t)); showToast(`Adding ${urls.length} pieces…`); scrollToId(secKey(t.roomId, t.section)); }} />
      )}

      {editing && (
        <EditSheet
          key={editing.id} item={editing} rooms={rooms} currency={currency} onUpload={uploadPhoto}
          onClose={() => setEditingId(null)}
          onSave={(patch, newUrl, photoChanged) => {
            const it = editing;
            setEditingId(null);
            updateItem(it.id, patch).then(() => { if (newUrl) refreshItem({ ...it, ...patch }, newUrl, photoChanged); });
          }}
          onRefresh={() => refreshItem(editing)}
          onRemove={() => removeItem(editing)}
        />
      )}

      {sheet?.kind === "addRoom" && (
        <NameSheet title="Add a room" label="Room name" placeholder="e.g. Living room" action="Add room"
          suggestions={["Living room", "Kitchen", "Bedroom", "Bathroom", "Dining room", "Office", "Hallway"].filter((s) => !rooms.some((r) => r.name.toLowerCase() === s.toLowerCase()))}
          onClose={() => setSheet(null)} onSave={addRoom} />
      )}
      {sheet?.kind === "editRoom" && sheetRoom && (
        <NameSheet title="Edit room" label="Room name" initial={sheetRoom.name} action="Save"
          onClose={() => setSheet(null)} onSave={(n) => renameRoom(sheetRoom, n)}
          removeLabel={`Remove room${sheetRoomItems.length ? ` and ${sheetRoomItems.length} piece${sheetRoomItems.length === 1 ? "" : "s"}` : ""}`}
          onRemove={() => removeRoom(sheetRoom)} />
      )}
      {sheet?.kind === "addSection" && sheetRoom && (
        <NameSheet title={`Add a section to ${sheetRoom.name}`} label="Section name" placeholder="e.g. Storage" action="Add section"
          suggestions={["Furniture", "Appliances", "Storage", "Decor", "Lighting", "Textiles"].filter((s) => !sectionsOf(sheetRoom).includes(s))}
          onClose={() => setSheet(null)} onSave={(n) => addSection(sheetRoom, n)} />
      )}
      {sheet?.kind === "editSection" && sheetRoom && sheet.section && (
        <NameSheet title="Edit section" label="Section name" initial={sheet.section} action="Save"
          onClose={() => setSheet(null)} onSave={(n) => renameSection(sheetRoom, sheet.section, n)}
          removeLabel={`Remove section${sheetSectionItems.length ? ` and ${sheetSectionItems.length} piece${sheetSectionItems.length === 1 ? "" : "s"}` : ""}`}
          onRemove={() => removeSection(sheetRoom, sheet.section)} />
      )}
      {sheet?.kind === "settings" && home && (
        <SettingsSheet home={home} onClose={() => setSheet(null)} onSave={saveHome} onCopied={() => showToast("Invite code copied.")} />
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

/* ---------- one room, with all its sections ---------- */

function RoomBlock({ room, single, onOpen, items, currency, selecting, selected, justAdded, secKey, onEditRoom, onAddSection, onEditSection, onAdd, onSelect, onEdit, onToggle, onRemove }) {
  const t = totals(items);
  const names = [...sectionsOf(room), ...new Set(items.map((i) => i.section).filter((s) => !sectionsOf(room).includes(s)))];
  return (
    <section className={`room${single ? " single" : ""}`} id={`room-${room.id}`}>
      <div className="room-head">
        <div>
          {single
            ? <h1 className="room-title">{room.name}</h1>
            : <h2 className="room-title"><button className="room-open" onClick={onOpen}>{room.name}</button></h2>}
          <p className="room-sub">{t.count ? `${money(t.included, currency)} · ${t.includedCount} of ${t.count} piece${t.count === 1 ? "" : "s"} included` : "No pieces yet"}</p>
        </div>
        <div className="head-actions">
          {!single && <button className="btn ghost" onClick={onOpen}>Open room</button>}
          <button className="btn" onClick={onAddSection}>+ Section</button>
          <button className="btn ghost" onClick={onEditRoom}>Edit room</button>
        </div>
      </div>

      {!names.length && (
        <button className="add-bar" onClick={onAddSection}>
          <span className="add-plus" aria-hidden="true">+</span>
          <span>Add a section</span>
          <small>e.g. Furniture, Storage, Decor</small>
        </button>
      )}

      {names.map((s) => {
        const list = items.filter((i) => i.section === s).sort((x, y) => new Date(y.created_at) - new Date(x.created_at));
        const st = totals(list);
        return (
          <div className="section" key={s} id={secKey(room.id, s)}>
            <div className="sec-head">
              <h3>{s}</h3>
              <span className="sec-meta">{list.length ? money(st.included, currency) : ""}</span>
              <span className="select-spacer" />
              <button className="sec-link" onClick={() => onEditSection(s)}>Edit</button>
            </div>
            <div className="grid">
              {!selecting && (
                <button className="add-tile" onClick={() => onAdd(s)}>
                  <span className="add-plus" aria-hidden="true">+</span>
                  <span>Add a piece</span>
                </button>
              )}
              {list.map((it) => (
                <Card key={it.id} item={it} currency={currency} fresh={justAdded === it.id}
                  selecting={selecting} selected={selected.has(it.id)} onSelect={() => onSelect(it.id)}
                  onEdit={() => onEdit(it.id)} onToggle={() => onToggle(it)} onRemove={() => onRemove(it)} />
              ))}
            </div>
          </div>
        );
      })}
    </section>
  );
}

/* ---------- pieces ---------- */

function AddSheet({ where, currency, readLink, onUpload, onClose, onAdd, onAddMany }) {
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
                    <button type="button" className="link" onClick={() => setShowPhoto((v) => !v)}>{showPhoto ? "Keep this photo" : "Change photo"}</button>
                  </>
                )}
              </div>
            </div>
            {!reading && readFailed && <p className="note">This shop didn&rsquo;t share all its details. Fill in anything missing below.</p>}
            {!reading && (
              <>
                {showPhoto && (
                  <PhotoPicker value={f.image} onUpload={onUpload}
                    onChange={(url) => { setF((p) => ({ ...p, image: url })); setImgFailed(false); }} />
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
    <article id={`piece-${item.id}`} className={`card${included ? "" : " off"}${loading ? " loading" : ""}${fresh ? " fresh" : ""}${selecting ? " selecting" : ""}${selected ? " selected" : ""}`}>
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

function EditSheet({ item, rooms, currency, onUpload, onClose, onSave, onRefresh, onRemove }) {
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
    }, newUrl, (cleanPhoto || null) !== (item.image_url || null));
  }

  return (
    <Sheet title="Edit piece" onClose={onClose}>
      <form onSubmit={save} className="form">
        <div className="edit-top">
          {photo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={photo} alt="" referrerPolicy="no-referrer" />
          ) : <div className="edit-blank" />}
          <div>
            <p className="card-shop">{item.shop}</p>
            <a className="link" href={item.url} target="_blank" rel="noopener noreferrer">Open in shop</a>
            <button type="button" className="link" onClick={onRefresh} disabled={loading}>{loading ? "Refreshing…" : "Refresh photo and price"}</button>
          </div>
        </div>
        <PhotoPicker value={photo} onChange={setPhoto} onUpload={onUpload} />
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

function PhotoPicker({ value, onChange, onUpload }) {
  const [showLink, setShowLink] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const fileRef = useRef(null);

  async function pick(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) { setError("Choose a photo file."); return; }
    setBusy(true); setError("");
    try { onChange(await onUpload(file)); }
    catch { setError("That photo didn't upload. Try again, or choose a smaller one."); }
    setBusy(false);
  }

  return (
    <div className="field">
      <span>Photo</span>
      <div className="photo-actions">
        <button type="button" className="btn" onClick={() => fileRef.current?.click()} disabled={busy}>
          {busy ? "Uploading…" : "Upload a photo"}
        </button>
        <button type="button" className="link" onClick={() => setShowLink((v) => !v)}>Use an image link</button>
        {value && <button type="button" className="link" onClick={() => onChange("")}>Remove photo</button>}
        <input ref={fileRef} type="file" accept="image/*" hidden onChange={pick} />
      </div>
      {showLink && (
        <>
          <input type="url" inputMode="url" value={value} onChange={(e) => onChange(e.target.value)} placeholder="Paste an image address" />
          <small className="field-hint">On the shop&rsquo;s page, right-click (or press and hold) the product photo, choose &ldquo;Copy image address&rdquo; and paste it here.</small>
        </>
      )}
      {error && <small className="field-hint error">{error}</small>}
    </div>
  );
}
