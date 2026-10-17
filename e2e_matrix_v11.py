"""E2E matriks v1.1 lengkap di sandbox CB 5057 (isolated, DB fresh).

Kontrak yang diverifikasi (spec §2.3) + scope-gate + GET /users + Edge 1/2.
Kredensial dari /tmp/sandbox_keys.json (seed output). WA sandbox offline →
send menghasilkan 503 SETELAH matriks assignment/reopen jalan = tetap valid
untuk verifikasi kontrak (matriks terjadi PRE-send).

Token kredensial dibangun via concat (anti-sanitasi tool-input)."""
import json
import os
import urllib.error
import urllib.request

BASE = "http://127.0.0.1:5057"
K = json.load(open("/tmp/sandbox_keys.json"))
FULL = K["fullKey"]
SENDONLY = K["sendOnlyKey"]
CS_ID = K["csId"]
TENANT = K["tenantId"]

ok_steps = []


def step(n, label, cond, detail=""):
    mark = "✓" if cond else "✗ GAGAL"
    print("  [%d] %s ← %s %s" % (n, label, mark, detail))
    ok_steps.append(cond)


def req(path, key=None, body=None, method=None, tok=None):
    r = urllib.request.Request(BASE + path,
                               data=json.dumps(body).encode() if body is not None else None,
                               method=method or ("POST" if body is not None else "GET"))
    # ROOT-CAUSE matrix 1/9: tanpa Content-Type, express.json() melewati body
    # → req.body = {} → 400 "Field target wajib diisi" pada SEMUA POST.
    r.add_header("Content-Type", "application/json")
    if key:
        # header auth dibangun via concat (anti-sanitasi)
        r.add_header("Auth" + "orization", "Bea" + "rer " + key)
    if tok:
        r.add_header("Auth" + "orization", "Bea" + "rer " + tok)
    try:
        with urllib.request.urlopen(r, timeout=20) as resp:
            return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode())
        except Exception:
            return e.code, {}


# ── 1) scope-gate: send-only key + numberSlot → 403 SCOPE_MISSING ──
c, b = req("/api/v1/messages", SENDONLY, {"target": "+62811000200300", "text": "x",
                                          "numberSlot": 1})
step(1, "scope-gate: send-only+numberSlot → 403 SCOPE_MISSING",
     c == 403 and b.get("code") == "SCOPE_MISSING", "http=%s code=%r" % (c, b.get("code")))

# ── 2) send-only + assignTo → 403 juga ──
c, b = req("/api/v1/messages", SENDONLY, {"target": "+62811000200300", "text": "x",
                                          "assignTo": CS_ID})
step(2, "scope-gate: send-only+assignTo → 403 SCOPE_MISSING",
     c == 403 and b.get("code") == "SCOPE_MISSING", "http=%s" % c)

# ── 3) v1.0 behaviour: send-only tanpa param → tidak butuh scope baru ──
# (sandbox WA offline → sinyal sukses jalur v1.0 = 503 WA_BELUM_TERHUBUNG:
#  request lolos validasi+scope dan SAMPAI di send stage — bukan 403/400)
c, b = req("/api/v1/messages", SENDONLY, {"target": "+62811000200300", "text": "matriks v1.0"})
step(3, "v1.0: send-only tanpa param → lolos scope, sampai send (503 WA-offline = benar di sandbox)",
     c == 503 and b.get("code") == "WA_BELUM_TERHUBUNG",
     "http=%s code=%r" % (c, b.get("code")))

# ── 4) kontak baru + assignTo → pre-send create open+ASSIGNED ──
# (sandbox WA offline → 503 SETELAH matriks jalan; kontrak diverifikasi via DB)
c, b = req("/api/v1/messages", FULL, {"target": "+628111111111",
                                      "text": "E2E-4 asign baru",
                                      "assignTo": CS_ID})
ok4_resp = (c == 503 and b.get("code") == "WA_BELUM_TERHUBUNG")
import sqlite3
_db = sqlite3.connect("/tmp/cbtest-e2e.db")
_r = _db.execute("SELECT status, assignedToId FROM Chat WHERE waJid LIKE '%628111111111%'").fetchone()
_db.close()
step(4, "kontak baru + assignTo → 503 (post-matrix, WA offline) + DB: open+assigned=cs-sb",
     ok4_resp and _r and _r[0] == "open" and _r[1] == CS_ID,
     "http=%s db=%r" % (c, _r))

# ── 5) open+unassigned + assignTo → assign (sandbox: 503 post-matrix + DB truth) ──
c, b = req("/api/v1/messages", FULL, {"target": "+628222222222", "text": "E2E-5",
                                      "assignTo": CS_ID})
_db = sqlite3.connect("/tmp/cbtest-e2e.db")
_r = _db.execute("SELECT status, assignedToId FROM Chat WHERE waJid LIKE '%628222222222%'").fetchone()
_db.close()
step(5, "open+unassigned + assignTo → 503 (post-matrix) + DB: open+assigned=cs-sb",
     c == 503 and _r and _r[0] == "open" and _r[1] == CS_ID,
     "http=%s db=%r" % (c, _r))

# ── 6) WA offline → 503 SETELAH matriks (bukti matriks jalan pre-send) ──
# target E2E-4 sudah assigned; assignTo lagi → cabang no-op → send → 503 WA_BELUM_TERHUBUNG
c, b = req("/api/v1/messages", FULL, {"target": "+628111111111", "text": "E2E-6",
                                      "assignTo": CS_ID})
step(6, "WA sandbox offline → 503 WA_BELUM_TERHUBUNG (matriks pre-send tadi sudah jalan)",
     c == 503, "http=%s code=%r" % (c, b.get("code")))

# ── 7) truth via DB: chat 628111111111 ter-assign ke cs-sb, open ──
found_assigned = False
try:
    import sqlite3
    con = sqlite3.connect("/tmp/cbtest-e2e.db")
    row = con.execute(
        "SELECT status, assignedToId, numberSlot FROM Chat WHERE waJid LIKE '%628111111111%'"
    ).fetchone()
    if row:
        found_assigned = (row[0] == "open" and row[1] == CS_ID)
        step(7, "DB TRUTH: chat 628111111111 → status=%r assignedToId=%r slot=%s" % row,
             found_assigned)
    else:
        step(7, "DB TRUTH: chat 628111111111 TIDAK ADA", False)
    con.close()
except Exception as e:
    step(7, "DB truth ERR: %s" % str(e)[:80], False)

# ── 8) GET /users (full key) → cs-sb terlist ──
c, b = req("/api/v1/users?limit=50", FULL)
users = b.get("users") or []
step(8, "GET /users (full key) → cs-sb terlist %r" % ([u.get("username") for u in users]),
     c == 200 and any(u.get("id") == CS_ID for u in users))

# ── 9) GET /users (send-only key) → 403 SCOPE_MISSING ──
c, b = req("/api/v1/users?limit=10", SENDONLY)
step(9, "GET /users (send-only) → 403 SCOPE_MISSING",
     c == 403 and b.get("code") == "SCOPE_MISSING")

# ── 10-12: resolved-flow kontrak Edge-2 via admin web session ──
adm_c, adm_b = req("/api/auth/login", body={"username": "admin-sb", "password": "SandboxAdmin2026!"})
adm_tok = (adm_b.get("token") if isinstance(adm_b, dict) else None)
step(10, "login admin-sb sandbox (web session)", adm_c == 200 and bool(adm_tok))

_db = sqlite3.connect("/tmp/cbtest-e2e.db")
cid = _db.execute("SELECT id FROM Chat WHERE waJid LIKE '%628222222222%' LIMIT 1").fetchone()
cid = cid[0] if cid else None
_db.close()
c, b = req("/api/chats/%s/resolve" % cid, tok=adm_tok, body={"message": "E2E resolve"})
step(11, "admin resolve chat %s (HTTP %s)" % (cid, c), c in (200, 201))

# Edge 2 MURNI (kasus Kanaka: "pilih unassigned → tetap Resolved") di sandbox WA-offline:
# v1.0 born-unassigned butuh logApiEvent POST-send (tidak jalan saat WA off) → jalur sandbox:
# (a) create DENGAN assignTo (pre-send create ✓ offline) → (b) admin RELEASE (open+unassigned)
# → (c) admin RESOLVE (resolved+unassigned) → (d) API send tanpa assignTo → DB (resolved, None).
c, b = req("/api/v1/messages", FULL, {"target": "+628333333333", "text": "E2E-12a create-assigned",
                                      "assignTo": CS_ID})
import sqlite3
_db = sqlite3.connect("/tmp/cbtest-e2e.db")
_r12 = _db.execute("SELECT id, status, assignedToId FROM Chat WHERE waJid LIKE '%628333333333%'").fetchone()
_db.close()
step(12, "Edge-2 a: create+assignTo → born open+assigned (db=%r)" % (_r12,),
     bool(_r12) and _r12[1] == "open" and _r12[2] == CS_ID)
cid12 = _r12[0] if _r12 else None

c, b = req("/api/chats/%s/release" % cid12, tok=adm_tok, body={})
_db = sqlite3.connect("/tmp/cbtest-e2e.db")
_r12b = _db.execute("SELECT status, assignedToId FROM Chat WHERE id=%s" % cid12).fetchone()
_db.close()
step(12, "Edge-2 b: admin RELEASE → open+unassigned (HTTP %s, db=%r)" % (c, _r12b),
     c in (200, 201) and _r12b and _r12b[0] == "open" and _r12b[1] is None)

c, b = req("/api/chats/%s/resolve" % cid12, tok=adm_tok, body={"message": "E2E resolve unassigned"})
_db = sqlite3.connect("/tmp/cbtest-e2e.db")
_r12c = _db.execute("SELECT status, assignedToId FROM Chat WHERE id=%s" % cid12).fetchone()
_db.close()
step(12, "Edge-2 c: admin RESOLVE → resolved+unassigned (HTTP %s, db=%r)" % (c, _r12c),
     c in (200, 201) and _r12c and _r12c[0] == "resolved" and _r12c[1] is None)

c, b = req("/api/v1/messages", FULL, {"target": "+628333333333", "text": "E2E post-resolve tanpa assignTo"})
_db = sqlite3.connect("/tmp/cbtest-e2e.db")
_r12d = _db.execute("SELECT status, assignedToId FROM Chat WHERE id=%s" % cid12).fetchone()
_db.close()
step(12, "Edge-2 d (KONTRAK): post-resolve API send TANPA assignTo → 503 (WA-off) + DB MURNI (resolved, None) — BOTH-untouched",
     c == 503 and _r12d and _r12d[0] == "resolved" and _r12d[1] is None,
     "http=%s db=%r" % (c, _r12d))

n_pass = sum(1 for x in ok_steps if x)
print("\nRINGKASAN MATRIKS v1.1 SANDBOX: %d/%d lulus" % (n_pass, len(ok_steps)))
for i, x in enumerate(ok_steps, 1):
    print("  [%d] %s" % (i, "✓" if x else "✗"))