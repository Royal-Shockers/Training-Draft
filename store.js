// Data layer. Two versions with the same functions:
//  - Firebase (live): shared database, Google sign-in.
//  - Demo: saves only in this browser, used until config.js has your Firebase settings.
import { firebaseConfig, OWNER_EMAIL } from "./config.js";
import { defaultLists } from "./defaults.js";

export const LIVE = Boolean(firebaseConfig.apiKey) && firebaseConfig.apiKey !== "PASTE_HERE";
const FIREBASE_VERSION = "10.12.2";

export const bucketOf = date => date.slice(0, 7); // games are stored in one document per month
export const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

function clean(m, by) {
  return {
    date: m.date, mode: m.mode, map: m.map,
    blue: [...m.blue], red: [...m.red], result: m.result,
    at: m.at || Date.now(), by: m.by || by || "",
  };
}

export function createStore(h) {
  return LIVE ? createFirebaseStore(h) : createDemoStore(h);
}

// ---------------- Demo ----------------
function sampleMatches(lists) {
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const pickN = (arr, n) => {
    const a = [...arr], out = [];
    while (out.length < n) out.push(a.splice(Math.floor(rnd() * a.length), 1)[0]);
    return out;
  };
  const pool = lists.brawlers.slice(0, 24).map(b => b.id);
  const out = [];
  const today = new Date();
  for (let i = 0; i < 40; i++) {
    const d = new Date(today.getTime() - Math.floor(rnd() * 30) * 86400000);
    const map = lists.maps[Math.floor(rnd() * lists.maps.length)];
    const six = pickN(pool, 6);
    const r = rnd();
    out.push({
      id: newId() + i, date: d.toISOString().slice(0, 10), map: map.id, mode: map.mode,
      blue: six.slice(0, 3), red: six.slice(3), result: r < 0.5 ? "W" : r < 0.88 ? "L" : "D", at: i,
    });
  }
  return out;
}

function createDemoStore(h) {
  const KEY = "brawl-team-tracker-demo-v1";
  let data = null;
  try { data = JSON.parse(localStorage.getItem(KEY)); } catch { data = null; }
  if (!data) { const lists = defaultLists(); data = { lists, matches: sampleMatches(lists) }; }
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(data)); } catch { /* storage full or blocked */ } };
  save(); // keep the same sample games on every visit
  const emit = () => { h.lists(structuredClone(data.lists)); h.matches(data.matches.map(m => ({ ...m }))); };
  setTimeout(() => { h.user({ email: "demo", name: "Demo user", role: "owner" }); emit(); }, 0);
  return {
    live: false,
    async signIn() {}, async signOut() {},
    async saveLists(fn) { data.lists = fn(structuredClone(data.lists)); save(); emit(); },
    async seedLists() { data.lists = defaultLists(); save(); emit(); },
    async addMatches(ms) { for (const m of ms) data.matches.push({ ...clean(m), id: m.id || newId() }); save(); emit(); },
    async updateMatch(old, m) { data.matches = data.matches.map(x => (x.id === old.id ? { ...clean(m), id: old.id } : x)); save(); emit(); },
    async deleteMatch(m) { data.matches = data.matches.filter(x => x.id !== m.id); save(); emit(); },
    async listMembers() { return []; },
    async addMember() { throw new Error("Teammates can be added once the site is connected to Firebase."); },
    async removeMember() {},
    resetDemo() { try { localStorage.removeItem(KEY); } catch { /* ignore */ } location.reload(); },
  };
}

// ---------------- Firebase ----------------
function friendly(e, email) {
  const code = (e && e.code) || "";
  if (code.includes("permission-denied")) {
    return email
      ? `${email} isn't allowed to make changes. Ask the owner to add you on the Teammates page.`
      : "Sign in with a team account to do that.";
  }
  if (code.includes("unavailable")) return "Can't reach the database. Check your internet connection.";
  return (e && e.message) || "Something went wrong.";
}

async function createFirebaseStore(h) {
  const base = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/`;
  const [{ initializeApp }, A, F] = await Promise.all([
    import(base + "firebase-app.js"), import(base + "firebase-auth.js"), import(base + "firebase-firestore.js"),
  ]);
  const app = initializeApp(firebaseConfig);
  const auth = A.getAuth(app);
  const db = F.getFirestore(app);
  const listsRef = F.doc(db, "config", "lists");
  let email = "";
  let unsubs = [];

  const listen = () => {
    unsubs.forEach(u => u());
    unsubs = [
      F.onSnapshot(listsRef, s => h.lists(s.exists() ? s.data() : null), e => h.error(friendly(e, email), "read")),
      F.onSnapshot(F.collection(db, "buckets"), qs => {
        const out = [];
        qs.forEach(d => {
          for (const [id, v] of Object.entries(d.data().m || {})) out.push({ ...v, id });
        });
        h.matches(out);
      }, e => h.error(friendly(e, email), "read")),
    ];
  };

  A.onAuthStateChanged(auth, async u => {
    email = u ? (u.email || "").toLowerCase() : "";
    if (!u) { h.user(null); listen(); return; }
    let role = "viewer";
    if (email === OWNER_EMAIL.trim().toLowerCase()) role = "owner";
    else {
      try { if ((await F.getDoc(F.doc(db, "members", email))).exists()) role = "member"; } catch { /* stays viewer */ }
    }
    h.user({ email, name: u.displayName || email, role });
    listen(); // listen again so a private database opens up after signing in
  });

  const guard = async fn => { try { return await fn(); } catch (e) { throw new Error(friendly(e, email)); } };

  return {
    live: true,
    async signIn() {
      try {
        await A.signInWithPopup(auth, new A.GoogleAuthProvider());
      } catch (e) {
        if (e.code === "auth/popup-closed-by-user" || e.code === "auth/cancelled-popup-request") return;
        if (e.code === "auth/unauthorized-domain") throw new Error("This web address isn't on Firebase's Authorized domains list yet (README step 7).");
        if (e.code === "auth/popup-blocked") throw new Error("Your browser blocked the sign-in window. Allow pop-ups for this site and try again.");
        throw e;
      }
    },
    signOut: () => A.signOut(auth),
    saveLists: fn => guard(() => F.runTransaction(db, async tx => {
      const s = await tx.get(listsRef);
      if (!s.exists()) throw new Error("The lists aren't set up yet.");
      tx.set(listsRef, fn(s.data()));
    })),
    seedLists: () => guard(() => F.runTransaction(db, async tx => {
      const s = await tx.get(listsRef);
      if (!s.exists()) tx.set(listsRef, defaultLists());
    })),
    addMatches: ms => guard(async () => {
      const uid = auth.currentUser ? auth.currentUser.uid : "";
      const groups = {};
      for (const m of ms) (groups[bucketOf(m.date)] ||= {})[m.id || newId()] = clean(m, uid);
      let batch = F.writeBatch(db), n = 0;
      for (const [month, entries] of Object.entries(groups)) {
        batch.set(F.doc(db, "buckets", month), { m: entries }, { merge: true });
        if (++n === 400) { await batch.commit(); batch = F.writeBatch(db); n = 0; }
      }
      if (n) await batch.commit();
    }),
    updateMatch: (old, m) => guard(async () => {
      const batch = F.writeBatch(db);
      const from = bucketOf(old.date), to = bucketOf(m.date);
      // Moving to another month: remove from the old month's document in the same batch.
      if (from !== to) batch.update(F.doc(db, "buckets", from), { ["m." + old.id]: F.deleteField() });
      // merge:true replaces every field of this game (arrays are replaced whole, not merged).
      batch.set(F.doc(db, "buckets", to), { m: { [old.id]: clean({ ...m, at: old.at, by: old.by }) } }, { merge: true });
      await batch.commit();
    }),
    deleteMatch: m => guard(() => F.updateDoc(F.doc(db, "buckets", bucketOf(m.date)), { ["m." + m.id]: F.deleteField() })),
    listMembers: () => guard(async () => (await F.getDocs(F.collection(db, "members"))).docs.map(d => d.id).sort()),
    addMember: e => guard(() => F.setDoc(F.doc(db, "members", e.trim().toLowerCase()), { addedAt: Date.now() })),
    removeMember: e => guard(() => F.deleteDoc(F.doc(db, "members", e))),
    resetDemo() {},
  };
}
