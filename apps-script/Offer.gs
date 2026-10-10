/**
 * Core logic for offering ownership of the caller's Drive items to the org.
 *
 * Mechanism (consumer -> consumer), per
 * https://developers.google.com/workspace/drive/api/guides/transfer-file :
 *   offer  = Permissions.create/update with { role: writer, pendingOwner: true }
 *   accept = Permissions.update with { role: owner } + transferOwnership=true
 *
 * Folder transfer is NOT recursive: every owned object needs its own offer.
 */

var ORG_EMAIL_KEY = 'ORG_EMAIL';
var RUN_BUDGET_MS = 4.5 * 60 * 1000;
var MAX_STATE_BYTES = 400000;
var FOLDER_MIME = 'application/vnd.google-apps.folder';

/**
 * Run once by the org (the script owner) from the Apps Script editor.
 * Resolves the hand-over target (the script project owner) and caches it.
 */
function setup() {
  var email = resolveScriptOwner_();
  if (!email) {
    throw new Error('Could not auto-detect the script owner. Set the ORG_EMAIL script property manually.');
  }
  PropertiesService.getScriptProperties().setProperty(ORG_EMAIL_KEY, email.toLowerCase());
  Logger.log('ORG_EMAIL set to %s', email);
  return email;
}

function resolveScriptOwner_() {
  var id = ScriptApp.getScriptId();
  try {
    var meta = Drive.Files.get(id, { fields: 'owners(emailAddress)' });
    var owners = (meta && meta.owners) || [];
    if (owners.length && owners[0].emailAddress) return owners[0].emailAddress;
    console.warn('Drive.Files.get returned no owner email for %s', id);
  } catch (e) {
    console.warn('Drive.Files.get owner failed: %s', (e && e.message) || e);
  }
  try {
    var owner = DriveApp.getFileById(id).getOwner();
    var email = owner && owner.getEmail();
    if (email) return email;
    console.warn('DriveApp owner email empty for %s', id);
  } catch (e) {
    console.warn('DriveApp owner failed: %s', (e && e.message) || e);
  }
  try {
    var me = Session.getEffectiveUser().getEmail();
    if (me) return me;
  } catch (e) {
    console.warn('getEffectiveUser failed: %s', (e && e.message) || e);
  }
  return null;
}

function getTargetEmail_() {
  var props = PropertiesService.getScriptProperties();
  var cached = props.getProperty(ORG_EMAIL_KEY);
  if (cached) return cached;
  var email = resolveScriptOwner_();
  if (email) {
    email = email.toLowerCase();
    props.setProperty(ORG_EMAIL_KEY, email);
    return email;
  }
  throw new Error(t_('errorNoTarget'));
}

function isOwnedByMe_(file) {
  var owners = file.owners || [];
  for (var i = 0; i < owners.length; i++) {
    if (owners[i].me) return true;
  }
  return false;
}

function toItem_(file) {
  return { id: file.id, name: file.name, mimeType: file.mimeType };
}

/**
 * IDs of every folder OWNED by the org account that the caller can see.
 * These are the roots we walk to find leaver-owned items placed in the org's
 * folder structure (directly or in a nested subfolder).
 */
function listOrgFolderIds_(target) {
  var ids = [];
  var pageToken = null;
  do {
    var res = Drive.Files.list({
      q: "'" + target + "' in owners and mimeType = '" + FOLDER_MIME + "' and trashed = false",
      fields: 'nextPageToken, files(id)',
      pageSize: 1000,
      pageToken: pageToken
    });
    (res.files || []).forEach(function (f) { ids.push(f.id); });
    pageToken = res.nextPageToken;
  } while (pageToken);
  return ids;
}

/**
 * Collect every item the caller owns that sits inside a folder owned by the
 * organization (directly or in any nested subfolder). Personal items that are
 * not under an org-owned folder are ignored.
 */
function collectOwnedItems_() {
  var target = getTargetEmail_();
  var items = [];
  var seen = {};
  var queue = listOrgFolderIds_(target);

  while (queue.length) {
    var parentId = queue.shift();
    if (seen[parentId]) continue;
    seen[parentId] = true;
    var token = null;
    do {
      var r = Drive.Files.list({
        q: "'" + parentId + "' in parents and trashed = false",
        fields: 'nextPageToken, files(id, name, mimeType, owners)',
        pageSize: 1000,
        pageToken: token
      });
      (r.files || []).forEach(function (f) {
        if (isOwnedByMe_(f)) items.push(toItem_(f));
        if (f.mimeType === FOLDER_MIME) queue.push(f.id);
      });
      token = r.nextPageToken;
    } while (token);
  }
  return items;
}

/**
 * Offer one item. Returns 'offered' or 'skipped'.
 *
 * Drive API v3 cannot set pendingOwner in the same call that first grants the
 * writer role (error: pendingOwnerWriterRequired). So: ensure the writer
 * permission, then update it with pendingOwner=true.
 */
function offerOne_(item, target) {
  var targetLc = target.toLowerCase();
  var existing = findTargetPermission_(item.id, targetLc);
  var permId;
  if (existing) {
    if (existing.role === 'owner' || existing.pendingOwner) return 'skipped';
    if (existing.role !== 'writer') {
      // Upgrade to writer first; pendingOwner requires an existing writer
      // (error: pendingOwnerWriterRequired otherwise).
      Drive.Permissions.update(
        { role: 'writer' },
        item.id,
        existing.id,
        { sendNotificationEmail: false }
      );
    }
    permId = existing.id;
  } else {
    var created = Drive.Permissions.create(
      { role: 'writer', type: 'user', emailAddress: target },
      item.id,
      { sendNotificationEmail: false }
    );
    permId = created.id;
  }
  updatePendingOwner_(item.id, permId, 5);
  return 'offered';
}

function findTargetPermission_(fileId, targetLc) {
  var listed = Drive.Permissions.list(fileId, {
    fields: 'permissions(id, type, role, emailAddress, pendingOwner)'
  });
  var perms = listed.permissions || [];
  for (var i = 0; i < perms.length; i++) {
    if (String(perms[i].emailAddress || '').toLowerCase() === targetLc) return perms[i];
  }
  return null;
}

function updatePendingOwner_(fileId, permissionId, attempts) {
  var lastErr = null;
  for (var i = 0; i < (attempts || 5); i++) {
    try {
      Drive.Permissions.update(
        { role: 'writer', pendingOwner: true },
        fileId,
        permissionId,
        { sendNotificationEmail: true }
      );
      return;
    } catch (e) {
      lastErr = e;
      Utilities.sleep(1000);
    }
  }
  throw lastErr;
}

/* ---- resumable job state (chunked Script Properties) ---- */

function saveState_(token, state) {
  var props = PropertiesService.getScriptProperties();
  deleteState_(token);
  var json = JSON.stringify(state);
  if (json.length > MAX_STATE_BYTES) throw new Error(t_('tooMany'));
  var size = 8000;
  var n = Math.max(1, Math.ceil(json.length / size));
  props.setProperty('job_' + token + '_n', String(n));
  for (var i = 0; i < n; i++) {
    props.setProperty('job_' + token + '_' + i, json.substr(i * size, size));
  }
}

function getState_(token) {
  var props = PropertiesService.getScriptProperties();
  var n = Number(props.getProperty('job_' + token + '_n') || 0);
  if (!n) return null;
  var json = '';
  for (var i = 0; i < n; i++) json += (props.getProperty('job_' + token + '_' + i) || '');
  return JSON.parse(json);
}

function deleteState_(token) {
  var props = PropertiesService.getScriptProperties();
  var n = Number(props.getProperty('job_' + token + '_n') || 0);
  props.deleteProperty('job_' + token + '_n');
  for (var i = 0; i < Math.max(n, 1) + 5; i++) {
    props.deleteProperty('job_' + token + '_' + i);
  }
}

/* ---- client-callable entry points ---- */

function getContext() {
  var email = '';
  try { email = Session.getActiveUser().getEmail(); } catch (e) { email = ''; }
  var target = '';
  var targetError = null;
  try {
    target = getTargetEmail_();
  } catch (e) {
    targetError = String((e && e.message) || e);
  }
  var selfTarget = !!(email && target && email.toLowerCase() === target.toLowerCase());
  return {
    email: email,
    target: target,
    targetError: targetError,
    selfTarget: selfTarget
  };
}

function assertNotSelfTarget_(target) {
  var me = '';
  try { me = Session.getActiveUser().getEmail(); } catch (e) { me = ''; }
  if (me && me.toLowerCase() === String(target).toLowerCase()) {
    throw new Error(t_('errorSelfTarget'));
  }
}

function countOwned() {
  return { count: collectOwnedItems_().length };
}

function startOffer() {
  var target = getTargetEmail_();
  assertNotSelfTarget_(target);
  var items = collectOwnedItems_();
  var token = Utilities.getUuid();
  var state = {
    target: target,
    items: items,
    index: 0,
    offered: 0,
    skipped: 0,
    errors: 0,
    errorList: []
  };
  saveState_(token, state);
  return runState_(token);
}

function continueOffer(token) {
  return runState_(token);
}

function runState_(token) {
  var start = Date.now();
  var state = getState_(token);
  if (!state) throw new Error('Unknown or expired job.');
  while (state.index < state.items.length && (Date.now() - start) < RUN_BUDGET_MS) {
    var item = state.items[state.index];
    try {
      var result = offerOne_(item, state.target);
      if (result === 'offered') state.offered++; else state.skipped++;
    } catch (e) {
      state.errors++;
      if (state.errorList.length < 50) {
        state.errorList.push({ id: item.id, name: item.name, message: String((e && e.message) || e) });
      }
    }
    state.index++;
  }
  var done = state.index >= state.items.length;
  if (done) {
    deleteState_(token);
  } else {
    saveState_(token, state);
  }
  return {
    done: done,
    token: done ? null : token,
    total: state.items.length,
    processed: state.index,
    offered: state.offered,
    skipped: state.skipped,
    errors: state.errors,
    errorList: state.errorList
  };
}
