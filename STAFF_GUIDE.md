# BOT MANUAL FOR STAFF (CAVEMAN EDITION)

No big words. No tech talk. Just what bot do.

---

### /verify

- **Internal Magic:** Bot look at sheet. Then bot write to sheet.
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
  - **Free Fire only:** Bot say no. Every Free Fire verify write a row to sheet, so always use /verify.

### /deny

- **Internal Magic:** Bot just mark ticket dead. For Free Fire, bot also delete the team row from sheet (if there is one).
- **What happen:**
  - Put ❌ on ticket name.
  - Tell human "Go away" (or say why if you give reason).
  - **Free Fire only:** bot remove team from sheet. If team was never verified, sheet already no row, bot say so.

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
  - **Free Fire only right now.** Old event sheet not read anymore.

### /setemail

- **Internal Magic:** Change email bot thinks human has.
- **What happen:**
  - Update pinned message at top of ticket.
  - Use this if human typo their email.
  - Bot check sheet again after you change it.
  - Free Fire: bot say no if that email already verified. Only one team per email.

### /count

- **Internal Magic:** Bot count how many verified.
- **What happen:**
  - Show count for every event that is open.
  - Free Fire count = how many teams done.

---

### Ticket Start

- User give email when ticket created.
- If email found in sheet → bot pin Name + DOB.
- If not found → ticket still created.

---

## FREE FIRE (different rule)

- Bot only ask 3 things at start: **Team Name, Email, Phone**.
- No sheet look at start. Sheet is EMPTY on purpose.
- Bot never check-mark anything. Sheet just grow one row per done team.
- Bot write to sheet only when staff run /verify.
- Sheet column: Team Name | Email Address | Phone | Discord ID | Timestamp | Thread Link

### One rule only once

- One Discord account = only one Free Fire verify.
- One email = only one Free Fire verify.
- Bot check 3 times: when human click button, when human send form, when staff run /verify.

### Who post what

- **Captain post everything.** IGN + UID for all 4-5 players, and screenshot of each player account on gamerscult.in
- **OR** captain mention his players (type @name) in his message. Bot add them to thread so they can see it and post their own screenshot. Bot send a message when it do.
- Bot send example picture after the ask message, so captain know what screenshot look like.
- Bot pin message on top: Team Name, Email, Phone, Discord, Status.

### Staff checklist

1. Open ticket, read pinned message.
2. Check captain post all IGN + UID (4-5 players).
3. Check each player gamerscult.in screenshot.
4. Run /verify.
5. Bot give role, put ✅, write sheet row, copy picture to backup room.

---

**PRO TIP:** Bot sync with sheet every 60 seconds. If human just registered, wait 1 minute before checking.

**SIGNS:**
- ✅ = verified
- ❌ = denied
- ❗ = no reply
