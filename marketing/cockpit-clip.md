# Conductor — cockpit clip (shot list)

**Format:** 30–45s screen capture, no voiceover (captions only), loopable. Vertical-safe
crop for X/social, but shoot 16:9.

**The one idea the clip must sell:** the fleet runs *untouched* — then one window hits the
gate and **stops for a yes/no**. That stop is the money shot. Everything before it exists to
establish that nobody's touching the keyboard.

---

## Shot list

### Shot 1 — "nobody's touching this" (0:00–0:08)  ← establishes unattended
- `conductor up` cockpit, full fleet of windows, all green / "WORKING NOW".
- Cursor parked, NOT moving. Rows tick forward on their own — tool calls update, a test count
  climbs ("Running tests — 18 passing" → "21 passing"), a commit lands.
- Caption: **"Five agents. Hands off the keyboard."**
- Hold long enough that it's obvious the progress is autonomous, not driven.

### Shot 2 — auto-continue, no human (0:08–0:16)
- Zoom one card. A routine prompt appears: *"Tests pass — update the README and commit?"*
- It **answers itself** — a subtle `✓ auto-continued` flash, the row keeps moving. No click.
- Caption: **"Reversible work just continues. You're not in the loop yet."**

### Shot 3 — THE MONEY SHOT: the gate (0:16–0:30)  ← hold longest, this is the clip
- Another window's row turns **red**, jumps to a **"WAITING ON YOU"** group at the top with a
  `GATED` badge. Everything else keeps running green behind it.
- Card reads: *"Ready to run `npm run deploy` — confirm?"* with one-tap chips: **Yes, deploy /
  No / Review first**.
- Cursor finally enters frame and hovers the chips. **Beat. Hold.** Let it sit unanswered for
  ~2s — the fleet is moving, this one is frozen waiting.
- Caption: **"It stops before deploy / send / delete / spend. That call is yours."**

### Shot 4 — the human lands it (0:30–0:36)
- Click **Yes, deploy**. The red card flips green, rejoins "WORKING NOW", deploy log streams.
- Caption: **"You own the irreversible moment. Nothing else."**

### Shot 5 — proof + tag (0:36–0:42)
- Quick cut to the gate logic on screen: `policy.js`, the deploy/send/delete/spend matcher
  visible. Caption: **"Model-free. Auditable. github.com/yksanjo/conductor"**
- End frame: 🎼 logo + headline **"Your agents run unattended — until something can't be undone."**

---

## Capture notes
- Use the **CSS cockpit mock in `site/index.html`** if a live fleet is hard to stage — it
  already has WORKING NOW / WAITING ON YOU / OPEN groups, the gated red card, and the reply
  chips. Drive it with a tiny JS timer to fake the auto-progress + the red-card transition.
- The contrast that sells it: **green rows moving on their own** vs. **one red row frozen,
  waiting on a human**. Keep both on screen during Shot 3 — don't crop the moving ones out.
- Do NOT script the cursor doing busywork in shots 1–2. The absence of input is the message.
- Keep the gated example concrete (`npm run deploy`), not abstract.
- ≤45s. The gate stop (Shot 3) should be ~⅓ of the runtime.
