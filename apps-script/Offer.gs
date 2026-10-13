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
var CHUNK_BUDGET_MS = 15 * 1000;
var YIELD_REMAIN = 8;
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

/** Resumable scan of the org's folder tree.
 *
 * Walks every folder owned by the org that the caller can see, in chunks, so
 * a large tree cannot exceed the 6-minute execution cap. Records the
 * transferable items (everything the caller owns inside those folders,
 * directly or nested) plus the folder tree for preview. When the scan is
 * done, the item list stays in the job state and is handed to startOffer() —
 * the walk happens only once.
 */
function startScan() {
  var target = getTargetEmail_();
  assertNotSelfTarget_(target);
  var token = Utilities.getUuid();
  var state = {
    phase: 'scan',
    target: target,
    roots: [],
    folders: {},
    queue: [],
    items: [],
    scanned: 0,
    checkedMap: {},
    skipCount: 0
  };
  var pageToken = null;
  do {
    var res = Drive.Files.list({
      q: "'" + target + "' in owners and mimeType = '" + FOLDER_MIME + "' and trashed = false",
      fields: 'nextPageToken, files(id, name)',
      pageSize: 1000,
      pageToken: pageToken
    });
    (res.files || []).forEach(function (f) {
      state.folders[f.id] = { n: f.name, s: [], v: false };
      state.roots.push(f.id);
      state.queue.push(f.id);
    });
    pageToken = res.nextPageToken;
  } while (pageToken);
  saveState_(token, state);
  return runScan_(token);
}

function continueScan(token) {
  return runScan_(token);
}

function runScan_(token) {
  var start = Date.now();
  var state = getState_(token);
  if (!state || state.phase !== 'scan') throw new Error('Unknown or expired scan.');
  while (state.queue.length) {
    if (state.queue.length >= YIELD_REMAIN && (Date.now() - start) >= CHUNK_BUDGET_MS) break;
    scanFolder_(state);
    state.scanned++;
  }
  if (state.queue.length === 0) {
    state.items = dedupeItems_(state.items);
    var assembled = assembleTreeFrom_(state);
    var skip = state.skipCount;
    state.phase = 'scanned';
    delete state.folders;
    delete state.roots;
    delete state.queue;
    delete state.scanned;
    delete state.checkedMap;
    delete state.skipCount;
    saveState_(token, state);
    return {
      done: true,
      token: token,
      count: assembled.count,
      found: assembled.count,
      skip: skip,
      trees: assembled.trees
    };
  }
  saveState_(token, state);
  return {
    done: false,
    phase: 'scan',
    token: token,
    found: state.items.length,
    scanned: state.scanned,
    pending: state.queue.length,
    skip: state.skipCount
  };
}

/**
 * One pass: walk one folder and record every item the caller owns that is not
 * yet pending or owned by the target. Each owned item needs a permissions.list
 * call, so the correct count and the offer job are built during the walk.
 */
function scanFolder_(state) {
  var fid = state.queue.shift();
  var f = state.folders[fid];
  if (!f || f.v) return;
  f.v = true;
  var targetLc = state.target.toLowerCase();
  var pageToken = null;
  do {
    var r = Drive.Files.list({
      q: "'" + fid + "' in parents and trashed = false",
      fields: 'nextPageToken, files(id, name, mimeType, owners)',
      pageSize: 1000,
      pageToken: pageToken
    });
    (r.files || []).forEach(function (ch) {
      if (ch.mimeType === FOLDER_MIME) {
        if (!f.s) f.s = [];
        var other = state.folders[ch.id];
        if (!other) {
          other = { n: ch.name, s: [], v: false };
          state.folders[ch.id] = other;
          state.queue.push(ch.id);
        }
        f.s.push(ch.id);
      }
      if (isOwnedByMe_(ch) && !state.checkedMap[ch.id]) {
        state.checkedMap[ch.id] = true;
        var existing = null;
        try {
          existing = findTargetPermission_(ch.id, targetLc);
        } catch (e) {
          existing = null;
        }
        if (existing && (existing.role === 'owner' || existing.pendingOwner)) {
          state.skipCount++;
          return;
        }
        state.items.push({ id: ch.id, name: ch.name, mimeType: ch.mimeType });
        if (ch.mimeType !== FOLDER_MIME) {
          if (!f.f) f.f = [];
          f.f.push(ch.id);
        }
      }
    });
    pageToken = r.nextPageToken;
  } while (pageToken);
}

function assembleTreeFrom_(state) {
  var keep = {};
  for (var i = 0; i < state.items.length; i++) keep[state.items[i].id] = true;
  var nodesById = {};
  function make(id) {
    if (nodesById[id]) return nodesById[id];
    var f = state.folders[id];
    var node = { id: id, name: f.n, mimeType: FOLDER_MIME, owned: !!keep[id], files: 0, transfers: 0, children: [] };
    (f.f || []).forEach(function (fid) { if (keep[fid]) node.files++; });
    nodesById[id] = node;
    var seen = {};
    (f.s || []).forEach(function (cid) {
      if (!state.folders[cid] || seen[cid]) return;
      seen[cid] = true;
      node.children.push(make(cid));
    });
    return node;
  }
  var roots = [];
  for (var i = 0; i < state.roots.length; i++) roots.push(make(state.roots[i]));
  var pruned = [];
  var count = 0;
  for (var j = 0; j < roots.length; j++) {
    var root = finalizeTree_(roots[j]);
    count += root.transfers;
    if (root.transfers > 0) pruned.push(root);
  }
  return { count: count, trees: dedupeRoots_(pruned) };
}

function fmtBytes_(b) {
  if (!b || b <= 0) return '0 B';
  var units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  var i = Math.floor(Math.log(b) / Math.log(1024));
  if (i < 0) i = 0;
  if (i > units.length - 1) i = units.length - 1;
  var v = b / Math.pow(1024, i);
  var lang = currentLang_();
  var s;
  try {
    var loc = (lang === 'nl') ? 'nl-NL' : 'en-US';
    var opts = { minimumFractionDigits: (i === 0 ? 0 : 1), maximumFractionDigits: (i === 0 ? 0 : 1) };
    s = new Intl.NumberFormat(loc, opts).format(v);
  } catch (e) {
    s = (i === 0 ? v.toFixed(0) : v.toFixed(1));
    if (lang === 'nl') s = s.replace('.', ',');
  }
  return s + ' ' + units[i];
}

function finalizeTree_(node) {
  var total = (node.owned ? 1 : 0) + (node.files || 0);
  var children = [];
  for (var i = 0; i < node.children.length; i++) {
    var child = finalizeTree_(node.children[i]);
    total += child.transfers;
    if (child.transfers > 0) children.push(child);
  }
  node.transfers = total;
  node.children = children;
  return node;
}

/**
 * The seed query lists every folder owned by the org at any depth, so an
 * org-owned subfolder of another org-owned folder would otherwise appear both
 * as a top-level root and nested. Keep only roots that are not a descendant of
 * another root.
 */
function dedupeRoots_(roots) {
  var kept = [];
  for (var i = 0; i < roots.length; i++) {
    var duplicate = false;
    for (var j = 0; j < roots.length; j++) {
      if (i === j) continue;
      if (containsId_(roots[j], roots[i].id)) { duplicate = true; break; }
    }
    if (!duplicate) kept.push(roots[i]);
  }
  return kept;
}

function containsId_(node, id) {
  if (node.id === id) return true;
  for (var i = 0; i < node.children.length; i++) {
    if (containsId_(node.children[i], id)) return true;
  }
  return false;
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
    selfTarget: selfTarget,
    mode: selfTarget ? 'accept' : 'offer',
    isOrg: selfTarget
  };
}

function assertNotSelfTarget_(target) {
  var me = '';
  try { me = Session.getActiveUser().getEmail(); } catch (e) { me = ''; }
  if (me && me.toLowerCase() === String(target).toLowerCase()) {
    throw new Error(t_('errorSelfTarget'));
  }
}

function startOffer(token) {
  var state = getState_(token);
  if (!state || state.phase !== 'scanned') {
    throw new Error(t_('noScan'));
  }
  assertNotSelfTarget_(state.target);
  var next = {
    target: state.target,
    items: state.items,
    index: 0,
    offered: 0,
    skipped: 0,
    errors: 0,
    errorList: []
  };
  saveState_(token, next);
  return runState_(token);
}

function continueOffer(token) {
  return runState_(token);
}

function runState_(token) {
  var start = Date.now();
  var state = getState_(token);
  if (!state) throw new Error('Unknown or expired job.');
  while (state.index < state.items.length) {
    if (state.index > 0 &&
        (state.items.length - state.index) >= YIELD_REMAIN &&
        (Date.now() - start) >= CHUNK_BUDGET_MS) break;
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

/* ---- Accept mode (scan pending offers to org) ---- */

function startAcceptScan() {
  var target = getTargetEmail_();
  var token = Utilities.getUuid();
  var totalBytes = 0;
  try {
    var about = Drive.About.get({ fields: 'storageQuota' });
    totalBytes = Number(about.storageQuota && about.storageQuota.usageInDrive) || 0;
  } catch (e) {
    totalBytes = 0;
  }
  var state = {
    phase: 'accept',
    target: target,
    pageToken: null,
    items: [],
    bytesChecked: 0,
    bytesFound: 0,
    checked: 0,
    totalBytes: totalBytes
  };
  saveState_(token, state);
  return runAcceptScan_(token);
}

function continueAcceptScan(token) {
  return runAcceptScan_(token);
}

function runAcceptScan_(token) {
  var start = Date.now();
  var state = getState_(token);
  if (!state || state.phase !== 'accept') throw new Error('Unknown or expired scan.');
  while (true) {
    if (state.pageToken === null && state.checked > 0) break;
    if (Date.now() - start >= CHUNK_BUDGET_MS) break;
    scanAcceptPage_(state);
  }
  if (state.pageToken === null && state.checked >= 0) {
    var flat = state.items;
    var treeRes = buildAcceptTree_(flat);
    state.phase = 'acceptScanned';
    state.items = flat;
    saveState_(token, state);
    return {
      done: true,
      mode: 'accept',
      token: token,
      count: flat.length,
      bytesFound: state.bytesFound,
    bytesFormatted: fmtBytes_(state.bytesFound),
    totalBytes: state.totalBytes,
    trees: treeRes.trees
  };
  }
  saveState_(token, state);
  return {
    done: false,
    mode: 'accept',
    token: token,
    checked: state.checked,
    found: state.items.length,
    bytesChecked: state.bytesChecked,
    bytesFound: state.bytesFound,
    bytesFormatted: fmtBytes_(state.bytesFound),
    totalBytes: state.totalBytes
  };
}

function scanAcceptPage_(state) {
  var targetLc = state.target.toLowerCase();
  var res = Drive.Files.list({
    q: "trashed=false and not 'me' in owners",
    fields: 'nextPageToken,files(id,name,mimeType,size,owners,permissions,parents)',
    pageSize: 1000,
    pageToken: state.pageToken
  });
  var files = res.files || [];
  for (var i = 0; i < files.length; i++) {
    var f = files[i];
    state.checked++;
    state.bytesChecked += Number(f.size || 0);
    var perms = f.permissions || [];
    for (var j = 0; j < perms.length; j++) {
      var p = perms[j];
      if (String(p.emailAddress || '').toLowerCase() === targetLc) {
        if (p.pendingOwner && !(p.role === 'owner')) {
          state.items.push({
            id: f.id,
            name: f.name,
            mimeType: f.mimeType,
            size: Number(f.size || 0),
            parents: f.parents || []
          });
          state.bytesFound += Number(f.size || 0);
        }
        break;
      }
    }
  }
  state.pageToken = res.nextPageToken || null;
}

function buildAcceptTree_(items) {
  if (!items.length) return { trees: [] };
  var folderMap = {};
  var folderIds = {};
  for (var i = 0; i < items.length; i++) {
    var parents = items[i].parents || [];
    for (var k = 0; k < parents.length; k++) folderIds[parents[k]] = true;
  }
  var ids = Object.keys(folderIds);
  for (var x = 0; x < ids.length; x += 100) {
    var chunk = ids.slice(x, Math.min(x + 100, ids.length));
    for (var c = 0; c < chunk.length; c++) {
      try {
        var meta = Drive.Files.get(chunk[c], { fields: 'id,name,mimeType' });
        folderMap[meta.id] = { id: meta.id, name: meta.name, mimeType: meta.mimeType };
      } catch (e) {}
    }
  }
  var nodesById = {};
  function getNode(id) {
    if (nodesById[id]) return nodesById[id];
    var m = folderMap[id] || { id: id, name: id };
    var n = { id: m.id, name: m.name, mimeType: m.mimeType || FOLDER_MIME, files: 0, transfers: 0, children: [], owned: false };
    nodesById[id] = n;
    return n;
  }
  for (var it = 0; it < items.length; it++) {
    var im = items[it];
    var ps = im.parents || [];
    if (ps.length === 0) {
      // orphans? treat as virtual root later? skip tree grouping for now
    } else {
      var pid = ps[0];
      var pnode = getNode(pid);
      pnode.files++;
    }
  }
  // Expand up to ancestors to build full hierarchy
  var expanded = true;
  var guard = 0;
  while (expanded && guard < 20) {
    expanded = false;
    guard++;
    var currentIds = Object.keys(nodesById);
    for (var ni = 0; ni < currentIds.length; ni++) {
      try {
        var fidNode = currentIds[ni];
        if (folderMap[fidNode] && folderMap[fidNode]._expanded) continue;
        var fmeta = Drive.Files.get(fidNode, { fields: 'id,name,mimeType,parents' });
        if (!folderMap[fmeta.id]) {
          folderMap[fmeta.id] = { id: fmeta.id, name: fmeta.name, mimeType: fmeta.mimeType };
        } else {
          folderMap[fmeta.id].name = fmeta.name;
          folderMap[fmeta.id].mimeType = fmeta.mimeType;
        }
        folderMap[fmeta.id]._expanded = true;
        var pids = fmeta.parents || [];
        if (pids.length > 0) {
          var p = pids[0];
          if (!nodesById[p]) {
            var pm = folderMap[p];
            if (!pm) {
              try {
                var pmeta = Drive.Files.get(p, { fields: 'id,name,mimeType' });
                pm = { id: pmeta.id, name: pmeta.name, mimeType: pmeta.mimeType };
                folderMap[p] = pm;
              } catch (e) {
                pm = { id: p, name: p };
                folderMap[p] = pm;
              }
            }
            nodesById[p] = { id: pm.id, name: pm.name, mimeType: pm.mimeType || FOLDER_MIME, files: 0, transfers: 0, children: [], owned: false };
            expanded = true;
          }
          var child = nodesById[fidNode];
          var parentNode = nodesById[p];
          var has = false;
          for (var hc = 0; hc < parentNode.children.length; hc++) {
            if (parentNode.children[hc].id === child.id) { has = true; break; }
          }
          if (!has) {
            parentNode.children.push(child);
            expanded = true;
          }
        }
      } catch (e) {}
    }
  }
  var roots = [];
  for (var rid in nodesById) {
    if (nodesById.hasOwnProperty(rid)) {
      var rn = nodesById[rid];
      var isRoot = true;
      for (var pid2 in nodesById) {
        if (nodesById.hasOwnProperty(pid2)) {
          var pn2 = nodesById[pid2];
          for (var cc = 0; cc < pn2.children.length; cc++) {
            if (pn2.children[cc].id === rn.id) { isRoot = false; break; }
          }
          if (!isRoot) break;
        }
      }
      if (isRoot) roots.push(rn);
    }
  }
  var pruned = [];
  var count = items.length;
  for (var r = 0; r < roots.length; r++) {
    var rt = finalizeTree_(roots[r]);
    if (rt.transfers > 0) pruned.push(rt);
  }
  return { trees: pruned.length ? pruned : [], count: count };
}
