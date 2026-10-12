# Drive ownership transfer

Help departing people mark the Google Drive documents they own as "offered for
ownership" to an org account, so the org can accept the transfer later in bulk.
All accounts involved are **consumer Google accounts** (some `@gmail.com`, some
Google Accounts registered with other addresses). The org account is also a
consumer account. Files are **not moved**; they stay where they are and only
gain a pending-ownership offer.

Status: offer phase deployed and validated live. See apps-script/README.md for current state and deployment info.

## Mechanism (Drive API v3, consumer -> consumer)

Confirmed in https://developers.google.com/workspace/drive/api/guides/transfer-file

1. **Offer** (leaver side). The current owner creates/updates the prospective
   owner's permission with `role=writer`, `type=user`, `pendingOwner=true`.
   This sends the prospective owner an email and marks the permission with
   `pendingOwner=true`. Nothing moves.
   **v3 caveat (verified live):** you cannot set `pendingOwner` in the same call
   that first grants the writer role — v3 silently ignores it (or errors
   `pendingOwnerWriterRequired`). Do it in two steps: (a) ensure the target has a
   `writer` permission, then (b) `Permissions.update` that permission with
   `pendingOwner=true`. The update response may not echo `pendingOwner`; confirm
   via `Permissions.list`.
2. **Accept** (org side, later). The prospective owner creates/updates their own
   permission with `role=owner` and `transferOwnership=true`. Ownership moves to
   them and the previous owner is downgraded to `writer`.

Notes / gotchas:
- **Folder ownership transfer is NOT recursive.** Google: "When you make
  someone else the owner of a folder, you still own the files inside." Offering
  (and accepting) a directory does not move ownership of its contents; every
  file and subfolder needs its own permission. Grouping owned files into one
  folder eases enumeration but does **not** reduce the number of
  offers/emails/acceptances. The accept side must also accept each item
  individually.
- Transfer to a **service account** always fails (no storage quota). The org
  must accept with a real consumer account.
- The prospective owner can also find the offers in the Drive UI by searching
  `pendingowner:me`.
- If the prospective owner is not in the same Workspace org (not our case),
  rules differ; we are purely consumer-to-consumer here.

## App routes vs a local binary

Three ways to "make an app". Only one fits this problem well.

1. **Apps Script web app (best fit).** Deploy an Apps Script as a web app with
   Execute as = "User accessing the web app" and access = "Anyone" (any
   signed-in Google account). The leaver opens a URL, authorizes once, and the
   script (running as them) walks the folder and creates the `pendingOwner`
   offers via the Advanced Drive service. The org opens the same URL to
   list/accept. No install, no cross-compile, no OAuth client of our own, any
   OS. This is what the community scripts do (e.g. tanaikech/OwnershipTransfer,
   ipums/gas-change-ownership).
   Cons: 6-minute execution cap and ~20k UrlFetch calls/day for consumer
   accounts (chunk + resume), and the usual "unverified app" consent warning.

2. **Google Workspace Add-on (Drive sidebar).** Nicer in-Drive UX via
   CardService, but heavier: manifest, contextual triggers, and distribution is
   either a Marketplace listing (verification + security review for the drive
   scope) or a private test deployment. Overkill for 5-10 users.

3. **Drive UI integration ("Open with" / "New" button).** Not usable here: it
   only surfaces editor apps that open/create files; there is no hook for a
   bulk ownership action.

For a handful of departing, non-technical people, the web app usually wins.

## Prior art

Existing open-source Apps Script tools, worth adapting/verifying rather than
reinventing:

- **tanaikech/OwnershipTransfer** (MIT, 2020): library with `setFolder` /
  `setFiles`; recursively transfers a folder plus files/subfolders via the
  Drive API using batched requests (BatchRequest + FilesApp). Key finding: a
  single folder-ownership transfer does **not** cascade to children, so every
  object needs its own permission. Not usable for shared drives;
  `sendNotificationEmail` can't be false.
- **tanaikech gist (2023)**: the exact consumer two-step we need —
  `Drive.Permissions.insert({role:"writer",type:"user",value:target,pendingOwner:true}, fileId)`
  to offer, then `role=owner` + `transferOwnership=true` to accept.
- **InduVarshini gist**: modern recursive bulk transfer with resumable state
  (`PropertiesService`), `MAX_ITEMS_PER_RUN = 150`, re-run until done. Good
  chunking template.
- **ipums/gas-change-ownership** (MPL): copy-and-archive approach (org ends up
  owning copies); older Workspace/service-account design, not `pendingOwner`.
- **austinsonger gist**, **taicv/apps-script-...-to-another-organization**:
  single-file / whole-drive and cross-org variants.

Our differentiator: a web-app wrapper (consent + chunked offer + a separate
org-side accept) instead of a paste-in script.

## Throughput and quotas (Apps Script, consumer account)

- **Script runtime: 6 minutes per execution** (hard kill). The real gate.
- **UrlFetchApp: 20,000 calls/day**, enforced as a rolling average (~0.23/s),
  so bursts error out before the daily count is reached.
- **Trigger runtime: 90 min/day total.**
- Advanced Drive service calls (`Drive.Permissions.insert`) are **not**
  UrlFetchApp calls; they count against the Drive API quota and are bounded
  mainly by the 6-minute runtime plus Drive per-user rate limits.

Rough capacity using the Advanced Drive service sequentially (enumeration +
per-file insert): a few hundred to ~1,000 objects per 6-minute run;
conservative scripts budget ~150/run. Batched (up to 100 sub-requests per
UrlFetch call), low thousands per run. Daily totals are mostly a function of
how many 6-minute runs you trigger: tens of thousands is achievable.

Caveat: each offer sends the target one Drive email, so thousands of files =
thousands of emails. Design the org side to accept via the `pendingowner:me`
search rather than the inbox.

Because folder transfer does not cascade, there is no "higher level" shortcut:
N owned objects means N offers, N emails, and N acceptances. Grouping files under
one folder only makes them easier to enumerate; it does not reduce the work on
either side.

## Deployment model (Apps Script web app)

An Apps Script project is a Drive file owned by one Google account. Deploy it
**from the org account**, not from a departing person's account.

Why the org account:
- The deployment owner controls the project, the consent-screen identity, and
  the deployment lifecycle. Versioned deployments can't be transferred and
  break if the owner's account is deleted, so anchor the project to a durable,
  org-controlled account (not an individual who might leave).
- The accept step is run by the org anyway, so one org-owned project can host
  both steps.

Two deployments of the same project:

- **offer** (for leavers): Execute as = "User accessing the web app"; Who has
  access = "Anyone" (any signed-in Google account). Running as the caller is
  mandatory — only the file owner can offer their own files — and it consumes
  the caller's quota.
- **accept** (for the org): Execute as = "User accessing the web app"; Who has
  access = "Only myself" (the org/deployer). Also gate in code by checking the
  caller's email.

Notes:
- No Marketplace listing or Google review is needed for a web-app URL.
- The `drive` scope is sensitive, so each user sees "Google hasn't verified
  this app" once and proceeds via Advanced > Go to (unsafe). Fine for 5-10
  trusted people. A standard GCP project can be attached later to control the
  consent-screen name/logo; full verification (restricted-scope security
  assessment) is overkill here.
- Develop and version from this repo with `clasp` (Google's Apps Script CLI);
  keep `appsscript.json` under source control.
- `executeAs: USER_ACCESSING` spreads quota across callers: leaver quota for
  offers, org quota for accepts.
- The hand-over target is **auto-detected** as the script project's owner (the
  org account): `DriveApp.getFileById(ScriptApp.getScriptId()).getOwner().getEmail()`.
  Because the web app runs as the *accessing* user, the leaver cannot read the
  script file's owner at runtime, so an owner runs `setup()` once to resolve and
  cache `ORG_EMAIL` in Script Properties; leavers read the cached value. A Script
  Property fallback is used if auto-detection ever fails.

## Development cycle (clasp)

The Apps Script project is the source of truth in this repo under `apps-script/`
and is pushed with `clasp` (Google's Apps Script CLI). Deployment is **not**
"share a Drive file": it is a versioned web-app release with its own `/exec`
URL. Each deployment carries its own `access`/`executeAs`
(`projects.deployments.entryPointConfig`), so `offer` and `accept` can be two
deployments of one project.

    npm i -g @google/clasp        # (needs Node; ask before installing)
    clasp login                   # as the ORG account
    clasp create --type webapp    # first time, writes .clasp.json + appsscript.json
    clasp clone <scriptId>        # or attach to an existing project
    clasp push                    # upload local sources
    clasp version "description"   # immutable snapshot
    clasp deploy -V <n> -d "prod" # create a deployment (/exec URL)

Loop: edit locally -> `clasp push` -> test on the owner-only head deployment
(`Deploy > Test deployments`, `/dev` URL) -> `clasp version` + `clasp deploy`
for the `/exec` URL that leavers use. `.clasprc.json` holds a refresh token:
keep it out of git.

## Dutch terminology (nl-NL)

Match Google Drive's own nl-NL wording in all user-facing text:

| English            | Dutch                         |
| ------------------ | ----------------------------- |
| owner              | eigenaar                      |
| editor             | bewerker                      |
| commenter          | reageerder                    |
| viewer             | kijker                        |
| folder / file      | map / bestand                 |
| My Drive           | Mijn Drive                    |
| Share (verb)       | delen                         |
| storage            | opslag                        |
| transfer ownership | eigendomsrechten overdragen   |
| ownership transfer | eigendomsoverdracht           |
| prospective owner  | beoogde eigenaar / nieuwe eigenaar |
| accept ownership   | eigendom accepteren           |
| pending-owner search | `pendingowner:me`           |

Localization is driven by the **end user's language**
(`Session.getActiveUserLocale()`): `nl*` -> Dutch, everything else -> English.
Google's own consent screen and Drive notification emails are localized by
Google; only our card/HTML is ours to translate.

## Leaver flow (offer web app)

The org sends the leaver one link: `.../exec`. The hand-over target is **not**
a URL parameter; it is auto-detected as the account that owns the deployment
(the org). The **scope** is also auto-detected: only items the leaver owns that
live inside a folder **owned by the org** (directly or in a nested subfolder)
are offered; the leaver's personal files outside the org's folders are ignored.
Implementation: list every folder owned by the org that the caller can see
(`'<org-email>' in owners and mimeType='application/vnd.google-apps.folder'`),
walk each tree (`'<id>' in parents`), and collect every item the caller owns.

1. Open the link in a browser, signed into the Google account that owns the
   documents.
2. Google consent: "<App name> wants to see, edit, create and delete all your
   Google Drive files" plus "Google hasn't verified this app". One time:
   Advanced -> Go to (unsafe) -> Allow.
3. Confirmation screen shows:
   - "Signed in as <email>" (confirm the right account; `?authuser=1` to switch)
   - Target: the auto-detected org account
   - Scope: "files and folders you own inside the organization's folders"
   - "N files you own will be marked as offered for ownership"
   - Plain-language explanation: nothing moves now; you stay the owner until
     the org accepts; each item is marked offered; you'll be emailed when it is
     accepted.
   - An "I understand" checkbox and an "Offer ownership" button.
4. Click Offer. The script walks the org's folder tree and offers each owned
   object via the `pendingOwner` permission, batched to fit the 6-minute cap,
   saving progress in `PropertiesService`. The UI shows progress and a
   "Continue" button when more than one run is needed.
5. Result screen: X offered, Y skipped, errors listed; resumable/retry; optional
   CSV log.
6. Later: the org accepts; the leaver gets Drive emails and is downgraded to
   `writer`. Optional re-run to withdraw offers before acceptance.

Edge cases:
- Wrong account: the screen shows the signed-in email; switch via the account
  chooser (`.../exec?authuser=1`). Offers attach to whichever account runs them
  and only work for files that account owns.
- Files spread across several accounts: run once per account.
- Idempotent: already-offered items are skipped on re-run.
- No install; works in desktop and mobile browsers.

## Auth model

The Apps Script web app needs no OAuth client of our own: each user authorizes
the standard Google consent screen, and the script runs as that user.

## Layout

    apps-script/      primary implementation (Apps Script web app)
      appsscript.json manifest (Drive v3 advanced service, scopes, webapp)
      Code.gs         doGet + client-callable entry points
      I18n.gs         nl/en strings, locale-driven
      Offer.gs        owned-item collection + pendingOwner offers + resume state
      Index.html      the leaver UI

## Verification status

- **Offer (two-step) — verified live:** the target must already have a `writer`
  permission before `pendingOwner=true` sticks; granting writer + setting
  `pendingOwner` in one v3 call does not work (`pendingOwnerWriterRequired`).
- **Accept — verified live:** the target runs
  `Permissions.update({role:'owner'})` with `transferOwnership=true`; the leaver
  is then downgraded to `writer`.
- **`pendingowner:me` is a Drive web-UI search term only** — it is *not* valid
  as a `files.list` API query and returns `Invalid Value`. The API cannot
  enumerate pending offers, so phase 2 must get file IDs from an offer ledger
  recorded at offer time.
- **Target and scope auto-detection — working in deployment:** `setup()`
  caches `ORG_EMAIL`; leavers read the cached value; the scope is computed from
  folders owned by the org. The self-target case (the org account opens the
  app) is blocked client- and server-side.
- **Folder transfer is not recursive:** one offer/email per object; grouping
  owned files into one folder eases enumeration but does not reduce the number
  of offers.
