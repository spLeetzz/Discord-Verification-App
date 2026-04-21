# BOT MANUAL FOR STAFF (CAVEMAN EDITION)

No big words. No tech talk. Just what bot do.

---

### /verify

- **Internal Magic:** Bot look at Google Sheet. Use email from pinned message.
- **What happen:**
  - If email on sheet (and no duplicate):
    - Give role to human.
    - Save Discord ID + mark verified on sheet.
    - Copy all chat pictures to backup room.
    - Put ✅ on ticket name.
    - Tell human "You good".

  - If email NOT on sheet: Bot say "I no find this person".
  - If duplicate email: Bot no verify ❌ (staff must fix sheet).

### /forceverify

- **Internal Magic:** Bot ignore Google Sheet. Bot ignore pinned message.
- **What happen:**
  - Give role to picked human.
  - Copy pictures to backup room.
  - Put ✅ on ticket name.
  - Tell human "You good".
  - **WARNING:** Bot no update sheet. Can cause mismatch later. Use only if needed.

### /deny

- **Internal Magic:** Bot just mark ticket dead.
- **What happen:**
  - Put ❌ on ticket name.
  - Tell human "Go away" (or say why if you give reason).

### /noreply

- **Internal Magic:** Bot mark ticket for later.
- **What happen:**
  - Put ❗ on ticket name.
  - That's it.

### /lookup

- **Internal Magic:** Bot look at EVERY sheet for one email.
- **What happen:**
  - Bot tell you if email is in BGMI, Chess, etc.
  - Bot tell you Name/Team if found.
  - Bot show how many entries for that email.

### /setemail

- **Internal Magic:** Change email bot thinks human has.
- **What happen:**
  - Update pinned message at top of ticket.
  - Use this if human typo their email.
  - Bot check sheet again after you change it.

---

### Ticket Start

- User give email when ticket created.
- If email found in sheet → bot pin Name + DOB.
- If not found → ticket still created.

---

**PRO TIP:** Bot sync with sheet every 60 seconds. If human just registered, wait 1 minute before checking.

**SIGNS:**

- ✅ = verified
- ❌ = denied
- ❗ = no reply
