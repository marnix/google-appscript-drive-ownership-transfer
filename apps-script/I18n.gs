/**
 * Localization.
 *
 * Language is chosen from the end user's locale (Session.getActiveUserLocale):
 * anything starting with "nl" -> Dutch, everything else -> English.
 * A LANG_OVERRIDE script property ("nl" or "en") forces a language for testing.
 */

var I18N = {
  nl: {
    appTitle: 'Eigendom overdragen (Google Drive)',
    intro: 'Met deze pagina draagt u het eigendom van uw Google Drive-bestanden en -mappen over aan de organisatie.',
    signedIn: 'Ingelogd als',
    accountHint: 'Gebruik het account dat eigenaar is van de bestanden.',
    switchAccount: 'Ander account gebruiken',
    target: 'Eigendom wordt aangeboden aan',
    scope: 'Bereik',
    scopeOrgFolders: 'Bestanden en mappen die u bezit binnen mappen van de organisatie',
    nothingMoves: 'Er verandert nu niets. U blijft eigenaar totdat de organisatie de overdracht accepteert. Voor elk object wordt afzonderlijk een aanbieding gedaan en ontvangt de organisatie een e-mail.',
    roleNote: 'Na acceptatie wordt uw rol \u2018bewerker\u2019.',
    countButton: 'Aantal objecten bepalen',
    counting: 'Bezig met tellen\u2026',
    countLabel: 'Objecten die u bezit: {n}',
    previewTitle: 'Mappen en bestanden die worden aangeboden, met aantal over te dragen objecten:',
    filesSummary: '{n} bestand(en)',
    understand: 'Ik begrijp dat er voor elk object afzonderlijk een eigendomsoverdracht wordt aangeboden.',
    offerButton: 'Eigendom aanbieden',
    continueButton: 'Doorgaan',
    offering: 'Bezig met aanbieden\u2026',
    progress: '{processed} van {total} verwerkt \u00b7 {offered} aangeboden \u00b7 {skipped} overgeslagen \u00b7 {errors} fouten',
    done: 'Klaar',
    resultSummary: '{offered} aangeboden \u00b7 {skipped} overgeslagen \u00b7 {errors} fouten',
    doneNote: 'De organisatie ziet de aanbiedingen in Drive via de zoekopdracht pendingowner:me en accepteert ze later.',
    needCheck: 'Vink eerst het vakje aan.',
    errorSelfTarget: 'U bent ingelogd als het doelaccount (de organisatie). Deze pagina is bedoeld voor het account dat de bestanden overdraagt, niet voor de organisatie zelf. Er wordt niets aangeboden.',
    errorNoTarget: 'Kon het doelaccount niet bepalen. Laat de beheerder setup() uitvoeren in het script.',
    errorGeneric: 'Er is iets misgegaan: {msg}',
    errorTitle: 'Fout',
    reload: 'Opnieuw',
    scanning: 'Bezig met scannen\u2026 {found} gevonden, {scanned} mappen doorzocht, {pending} nog te doorzoeken',
    noScan: 'Scan de objecten eerst via \u2018Aantal objecten bepalen\u2019.',
    tooMany: 'Te veel objecten voor \u00e9\u00e9n opdracht; de taak is te groot.'
  },
  en: {
    appTitle: 'Drive ownership transfer',
    intro: 'This page offers the ownership of your Google Drive files and folders to the organization.',
    signedIn: 'Signed in as',
    accountHint: 'Use the account that owns the files.',
    switchAccount: 'Use another account',
    target: 'Ownership is offered to',
    scope: 'Scope',
    scopeOrgFolders: 'Files and folders you own inside the organization\'s folders',
    nothingMoves: 'Nothing changes yet. You remain the owner until the organization accepts the transfer. Each object is offered separately and the organization receives an email for it.',
    roleNote: 'After acceptance your role becomes \u2018editor\u2019.',
    countButton: 'Count objects',
    counting: 'Counting\u2026',
    countLabel: 'Objects you own: {n}',
    previewTitle: 'Folders and files that will be offered, with the number of items per folder:',
    filesSummary: '{n} file(s)',
    understand: 'I understand that a separate ownership transfer is offered for every object.',
    offerButton: 'Offer ownership',
    continueButton: 'Continue',
    offering: 'Working\u2026',
    progress: '{processed} of {total} processed \u00b7 {offered} offered \u00b7 {skipped} skipped \u00b7 {errors} errors',
    done: 'Done',
    resultSummary: '{offered} offered \u00b7 {skipped} skipped \u00b7 {errors} errors',
    doneNote: 'The organization sees the offers in Drive by searching pendingowner:me and accepts them later.',
    needCheck: 'Tick the box first.',
    errorSelfTarget: 'You are signed in as the target account (the organization). This page is for the account handing over the files, not the organization itself. Nothing is offered.',
    errorNoTarget: 'Could not determine the target account. Ask the administrator to run setup() in the script.',
    errorGeneric: 'Something went wrong: {msg}',
    errorTitle: 'Error',
    reload: 'Reload',
    scanning: 'Scanning\u2026 {found} found, {scanned} folders searched, {pending} to go',
    noScan: 'Scan the objects first via \u2018Count objects\u2019.',
    tooMany: 'Too many objects for a single job; the task is too large.'
  }
};

function currentLang_() {
  var override = PropertiesService.getScriptProperties().getProperty('LANG_OVERRIDE');
  if (override && I18N[override]) return override;
  var loc = '';
  try { loc = Session.getActiveUserLocale() || ''; } catch (e) { loc = ''; }
  loc = String(loc).toLowerCase();
  return loc.indexOf('nl') === 0 ? 'nl' : 'en';
}

function strings_() {
  return I18N[currentLang_()];
}

function t_(key, subs) {
  var lang = currentLang_();
  var s = I18N[lang][key];
  if (s == null) s = I18N.en[key];
  if (s == null) s = key;
  if (subs) {
    Object.keys(subs).forEach(function (k) {
      s = s.split('{' + k + '}').join(String(subs[k]));
    });
  }
  return s;
}
