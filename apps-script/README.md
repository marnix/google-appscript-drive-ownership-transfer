# Drive ownership transfer — Apps Script web app

Primary implementation. Anyone who owns files (departing or current) can open
the link, authorize once, and the script (running as them) marks every Drive
item they own in the scoped folders as **offered for ownership** to the org
account. The org account can use the same URL in accept mode to accept pending
offers later in bulk.

See the repo `README.md` for the full design.

## Files

    appsscript.json   manifest: Advanced Drive service v3, drive scope,
                      webapp access=ANYONE, executeAs=USER_ACCESSING
    Code.gs           doGet + include()
    I18n.gs           nl/en strings, chosen from the end user's locale
    Offer.gs          setup(), target auto-detect, owned-item collection,
                      pendingOwner offers, chunked/resumable job state
    Index.html        the leaver UI

## One-time setup (as the org account)

1. `clasp login` as the **org account** (the durable account that should own the
   project and be the hand-over target).
2. `clasp create --type webapp --title "Drive ownership transfer"` (or
   `clasp clone <id>`), then `clasp push`.
3. In the editor, enable **Services > Drive API v3**.
4. Run the `setup()` function once. It resolves the target email
   (`DriveApp.getFileById(ScriptApp.getScriptId()).getOwner().getEmail()`) and
   caches it in a Script Property `ORG_EMAIL`. Verify the log line.
5. Deploy: **Deploy > New deployment > Web app**, Execute as *User accessing the
   web app*, Who has access *Anyone*. Copy the `/exec` URL.

## Dev cycle (clasp)

    npm i -g @google/clasp          # not installed here; ask before installing
    clasp login                     # as the org account
    clasp push                      # edit locally -> push
    # test on Deploy > Test deployments (/dev URL, owner only)
    clasp version "v1"
    clasp deploy -V <n> -d "prod"

`.clasprc.json` (refresh token) is gitignored — never commit it. `.clasp.json`
contains your deploy-specific script id, so it is gitignored too; copy
`.clasp.json.example` to `.clasp.json` and paste the id there.

## Leaver URL

    <exec-url>     # no parameters needed; scope and target are auto-detected

Scope = only the Drive items the caller **owns** that sit inside a folder
**owned by the org** (directly or in any nested subfolder). Personal files
outside the org's folders are never offered. The target is the org account
(script owner, cached by `setup()`); it is never a URL parameter.
