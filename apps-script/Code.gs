/**
 * Web app entry point.
 *
 * The scope is auto-detected: only items the caller owns that live inside a
 * folder owned by the org account are offered. No URL parameters are needed.
 * The hand-over target is NOT a parameter; it is the script owner (the org).
 */

function doGet(e) {
  var t = HtmlService.createTemplateFromFile('Index');
  t.lang = currentLang_();
  t.stringsJson = JSON.stringify(strings_());
  t.appTitle = t_('appTitle');
  return t.evaluate()
    .setTitle(t_('appTitle'))
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}
