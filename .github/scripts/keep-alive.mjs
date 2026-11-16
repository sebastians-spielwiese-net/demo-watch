// Visits every Streamlit Community Cloud demo with a real headless-browser
// page load (not just a curl/HEAD request) so the app is treated as an
// actual visit and doesn't fall asleep from inactivity. If a demo is
// already asleep, clicks the "wake it back up" button and waits for the
// real reboot before checking the app rendered.
import { writeFileSync } from "node:fs";
import { chromium } from "playwright";

const DEMO_URLS = [
  "https://spielwiese-figurenwert.streamlit.app/",
  "https://spielwiese-taktik-muster.streamlit.app/",
  "https://spielwiese-partieformular.streamlit.app/",
];

// KEEP_ALIVE_ONLY=multicriteria,raptor node .github/scripts/keep-alive.mjs visits just the matching demos (local check).
const only = (process.env.KEEP_ALIVE_ONLY ?? "").split(",").filter(Boolean);
// KEEP_ALIVE_URLS=<url>,<url> visits exactly these full URLs (also demos not yet in DEMO_URLS); used by
// `portfolio_ops deploy-check --browser` right after a push wave. KEEP_ALIVE_ATTEMPTS lowers the retry passes (default 3).
const explicit = (process.env.KEEP_ALIVE_URLS ?? "").split(",").filter(Boolean);
// KEEP_ALIVE_URLS_FROM=<Seite>,<Seite> nimmt statt der Liste oben alle Demo-Adressen, die auf diesen Seiten stehen (im öffentlichen Repo
// demo-watch: suche-index.json der Website, dort stehen alle Demo-Adressen der Website; tools/check_consistency.py prüft das). So muss dort nichts nachgezogen werden.
const from = (process.env.KEEP_ALIVE_URLS_FROM ?? "").split(",").filter(Boolean);
let listed = DEMO_URLS;
if (from.length && !explicit.length) {
  const found = new Set();
  for (const src of from) {
    const res = await fetch(src);
    if (!res.ok) throw new Error(`KEEP_ALIVE_URLS_FROM: ${src} antwortet mit HTTP ${res.status}`);
    for (const m of (await res.text()).matchAll(/https:\/\/[a-z0-9-]+\.streamlit\.app\//g)) found.add(m[0]);
  }
  if (found.size < 50) throw new Error(`KEEP_ALIVE_URLS_FROM: nur ${found.size} Adressen gefunden, das ist zu wenig`);
  listed = [...found];
}
const selected = explicit.length ? explicit : only.length ? listed.filter((u) => only.some((o) => u.includes(o))) : listed;
// KEEP_ALIVE_ONLY_ASLEEP=1 besucht nur die Demos, die gerade schlafen (Workflow "Wake sleeping demos", alle 30 Minuten). Der Zustand kommt
// aus dem Health-Endpunkt der Cloud, der nichts aufweckt (gemessen 2026-11-05): 200 mit "ok" = wach, 400 ohne Inhalt = schläft,
// 404 = die Cloud kennt die Adresse nicht. Die Cloud hängt bei etwa jeder siebten Anfrage (Zeitablauf, HTTP 500): solche Antworten werden
// bis zu dreimal wiederholt und gelten danach als unklar, die Demo wird dann vorsichtshalber besucht (ein Besuch einer wachen Demo schadet nicht).
const onlyAsleep = process.env.KEEP_ALIVE_ONLY_ASLEEP === "1";
async function healthState(url) {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(`${url}~/+/_stcore/health`, { signal: AbortSignal.timeout(15_000) });
      if (res.status === 200) return "wach";
      if (res.status === 400) return "schläft";
      if (res.status === 404) return "unbekannt";
    } catch {
      // Zeitablauf oder Verbindungsfehler: nächster Versuch
    }
  }
  return "unklar";
}
async function filterAsleep(all) {
  const states = new Array(all.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: 12 }, async () => {
      while (next < all.length) {
        const i = next++;
        states[i] = await healthState(all[i]);
      }
    }),
  );
  const count = (k) => states.filter((x) => x === k).length;
  console.log(`Zustand von ${all.length} Demos: ${count("wach")} wach, ${count("schläft")} schlafen, ${count("unklar")} unklar, ${count("unbekannt")} unbekannt (404, nicht besucht).`);
  return all.filter((_, i) => states[i] === "schläft" || states[i] === "unklar");
}
const urls = onlyAsleep ? await filterAsleep(selected) : selected;
if (onlyAsleep && urls.length === 0) {
  console.log("Keine schlafende Demo, nichts zu tun.");
  process.exit(0);
}
// KEEP_ALIVE_JSON=<Datei> schreibt zusätzlich das Ergebnis je Adresse als JSON ([{url, klasse, detail}], klasse = ok | skriptfehler |
// nicht-gefunden | unklar); `portfolio_ops deploy-check --browser` und die Tests lesen es. KEEP_ALIVE_SHELL_TIMEOUT_MS verkürzt nur das
// Warten auf den App-Rahmen (Standard 150 s, ein Kaltstart braucht es); gedacht für lokale Prüfseiten, der Workflow setzt es nicht.
const jsonOut = process.env.KEEP_ALIVE_JSON ?? "";
const SHELL_TIMEOUT_MS = Number.parseInt(process.env.KEEP_ALIVE_SHELL_TIMEOUT_MS ?? "", 10) || 150_000;

// Streamlit Community Cloud's sleep-screen wake button. Verified 2026-09-07
// against a real sleeping app: the sleep screen (and its button) renders in
// the TOP-level document, not inside the streamlitApp iframe - the iframe
// only exists once the app is actually awake. The iframe candidate below is
// kept as a defensive fallback in case that ever changes, matched loosely
// ("Yes, get this app back up!" historically) in case the wording does.
const WAKE_BUTTON_PATTERN = /get this app back up|wake.*app/i;

// Die Schlafseite braucht nach domcontentloaded 3 bis 4 s, bis der Knopf da ist (gemessen 2026-11-04: nach 1 s leer, nach 4 s da), unter
// Last in der CI länger. Ein festes Warten von 4 s verpasste ihn deshalb: der Besuch lief dann 150 s auf einen App-Rahmen, den eine
// schlafende App nie liefert (2026-11-03/04: 448 von 452 Besuchen, kein einziges OK, Läufe über 5 Stunden, schlafende Demos nie geweckt).
// Jetzt wird auf Knopf ODER App-Rahmen gewartet, was zuerst kommt; bleibt beides aus, wird die Seite neu geladen (siehe bringUp).
const SETTLE_MS = Number.parseInt(process.env.KEEP_ALIVE_SETTLE_MS ?? "", 10) || 45_000;
const MAX_RELOADS = 1;

async function appFrameNow(page) {
  const frames = page.frames();
  const ordered = [...frames.filter((f) => f !== page.mainFrame()), page.mainFrame()];
  for (const frame of ordered) {
    try {
      if ((await frame.locator('[data-testid="stAppViewContainer"]').count()) > 0) return frame;
    } catch {
      // Frame ist gerade weg oder lädt neu - nächster Kandidat
    }
  }
  return null;
}

async function wakeButtonNow(page) {
  const candidates = [
    page.getByRole("button", { name: WAKE_BUTTON_PATTERN }).first(),
    page.frameLocator('iframe[title="streamlitApp"]').getByRole("button", { name: WAKE_BUTTON_PATTERN }).first(),
  ];
  for (const btn of candidates) {
    try {
      if (await btn.isVisible()) return btn;
    } catch {
      // Seite lädt gerade neu - beim nächsten Durchlauf erneut
    }
  }
  return null;
}

// Wartet höchstens timeoutMs auf das, was zuerst erscheint: { kind: "app", frame } oder { kind: "asleep", button }; null bei Zeitablauf.
async function waitForWakeOrApp(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  do {
    const frame = await appFrameNow(page);
    if (frame) return { kind: "app", frame };
    const button = await wakeButtonNow(page);
    if (button) return { kind: "asleep", button };
    await page.waitForTimeout(500);
  } while (Date.now() < deadline);
  return null;
}

// Die Status-Schnittstelle der Cloud nennt den Zustand der App (beobachtet 2026-11-04: 12 = schläft, 5 = läuft); nur für die Fehlermeldung.
async function appStatus(url) {
  try {
    const res = await fetch(`${url}api/v2/app/status`, { signal: AbortSignal.timeout(10_000) });
    const m = (await res.text()).match(/"status":(\d+)/);
    return m ? m[1] : `HTTP ${res.status}`;
  } catch {
    return "keine Antwort";
  }
}

// Ergebnis eines Besuchs: { ok: true } oder { ok: false, kind, detail }. kind "skriptfehler" (die App zeigt eine Fehlerbox) und
// "nicht-gefunden" (die Cloud kennt die Adresse nicht) sind endgültig und werden nicht wiederholt; "unklar" (Zeitlimit, Cloud-Hänger)
// kommt in die Wiederholungsdurchgänge, denn ein langsamer Kaltstart sieht genauso aus.
const FINAL_KINDS = new Set(["skriptfehler", "nicht-gefunden"]);

// Bringt die Seite bis zu einem App-Rahmen mit stAppViewContainer: schlafende Apps wecken (Knopf klicken, dann auf den Kaltstart warten,
// höchstens SHELL_TIMEOUT_MS insgesamt), bei Stillstand einmal neu laden. Streamlit rendert die App in einem Unter-Frame
// (iframe title="streamlitApp"); der Rahmen kann später als die Hauptseite auftauchen oder nach einem Reboot ersetzt werden.
// Neu laden hilft auch gegen einen Hänger der Cloud: einzelne Frontend-Dateien (JS-Chunks) antworten dort mitunter erst nach 40 bis
// 60 s mit HTTP 500, der Rahmen bleibt dann leer; beim nächsten Laden kommen dieselben Dateien sofort (gemessen 2026-11-04).
async function bringUp(page, url) {
  const deadline = Date.now() + SHELL_TIMEOUT_MS;
  let clicks = 0;
  let reloads = 0;
  while (Date.now() < deadline) {
    const window = Math.min(clicks > 0 ? 90_000 : SETTLE_MS, deadline - Date.now());
    const seen = await waitForWakeOrApp(page, window);
    if (seen?.kind === "app") return seen.frame;
    if (seen?.kind === "asleep") {
      if (clicks >= 3) break;
      clicks++;
      console.log(`  -> asleep, clicking wake button (${clicks}): ${url}`);
      await seen.button.click();
      console.log(`  -> wake button clicked, waiting for reboot: ${url}`);
      await page.waitForLoadState("load", { timeout: 45_000 }).catch(() => {});
      continue;
    }
    if (reloads >= MAX_RELOADS) break;
    reloads++;
    console.log(`  -> neither wake button nor app frame after ${Math.round(window / 1000)}s, reloading: ${url}`);
    await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});
  }
  const state = clicks > 0 ? `nach ${clicks}x Wecken` : "ohne Wecken-Knopf";
  throw new Error(`Timeout: kein App-Rahmen mit stAppViewContainer gefunden (${state}, ${reloads}x neu geladen, Status der App: ${await appStatus(url)})`);
}

// Bis ans Ende scrollen: Fehlerboxen unter einem Expander oder weit unten stehen erst nach dem Rendern, Inhalte folgen lazy.
// Streamlit scrollt je nach Version in stMain, stAppViewContainer oder im Dokument - alle bekannten Kandidaten werden bewegt.
async function scrollToEnd(frame, page) {
  let last = -1;
  for (let i = 0; i < 3; i++) {
    const height = await frame
      .evaluate(() => {
        const targets = [document.scrollingElement, ...document.querySelectorAll('[data-testid="stMain"], [data-testid="stAppViewContainer"], section.main')];
        let max = 0;
        for (const el of targets) {
          if (!el) continue;
          el.scrollTop = el.scrollHeight;
          max = Math.max(max, el.scrollHeight);
        }
        return max;
      })
      .catch(() => last);
    await page.waitForTimeout(500);
    if (height === last) break;
    last = height;
  }
}

// Erste aussagekräftige Zeile eines Fehlertexts („KeyError: 'x'“, nicht die Überschrift „Traceback:“), auf 160 Zeichen gekürzt.
function firstErrorLine(text) {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l && !/^traceback( \(most recent call last\))?:?$/i.test(l));
  const named = lines.slice(0, 8).find((l) => /\b[A-Za-z_]*(Error|Exception)\b/.test(l));
  return (named ?? lines[0] ?? "Fehlerbox ohne Text").slice(0, 160);
}

// Sucht im App-Frame nach Fehlerelementen: stException (jede Python-Ausnahme der App), stAlert mit Fehlerklasse (st.error) nur, wenn der
// Text wie eine Python-Ausnahme aussieht - eine absichtliche Hinweisbox der Demo („Eingabe ungültig“) ist kein Skriptfehler.
async function findScriptError(frame) {
  const found = await frame.evaluate(() => {
    const pythonError = /Traceback|\b[A-Za-z_]*(Error|Exception)\b/;
    const exception = document.querySelector('[data-testid="stException"]');
    if (exception) {
      const message = exception.querySelector('[data-testid="stExceptionMessage"]');
      return { source: "stException", text: ((message ?? exception).innerText || exception.textContent || "").trim() };
    }
    for (const alert of document.querySelectorAll('[data-testid="stAlert"]')) {
      const text = (alert.innerText || alert.textContent || "").trim();
      const isError = alert.querySelector('[data-testid="stAlertContentError"]') !== null || /error|danger/i.test(alert.className);
      if (isError && pythonError.test(text)) return { source: "stAlert", text };
    }
    return null;
  });
  return found ? firstErrorLine(found.text) : null;
}

async function visit(context, url) {
  const page = await context.newPage();
  try {
    // "networkidle" is unreliable for Streamlit: the app holds a persistent
    // WebSocket open, which on some demos never lets the network go idle -
    // domcontentloaded is enough here, the real confirmation is the
    // stAppViewContainer wait below.
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    // Unbekannte Adresse: die Cloud antwortet 404 mit einer Weiterleitung auf errors/not_found - kein Warten auf einen App-Rahmen.
    if (response?.status() === 404 || /errors\/not_found/.test(page.url())) {
      return { ok: false, kind: "nicht-gefunden", detail: "App existiert nicht (HTTP 404 bzw. errors/not_found)" };
    }

    // Weckt eine schlafende App und wartet auf den App-Rahmen; ein Kaltstart (schwere Demos, z. B. OR-Tools/CP-SAT-Importe) kann weit über
    // eine Minute dauern, deshalb ist das Limit großzügig.
    const appFrame = await bringUp(page, url);
    const statusWidget = appFrame.locator('[data-testid="stStatusWidget"]');

    // The app shell renders even when the script itself crashed (ImportError,
    // uncaught exception): Streamlit then shows a red exception box inside
    // the app instead of failing the page load. Wait for the first script run
    // to finish (the "Running" indicator disappears), then look for one. The
    // indicator is also "hidden" before the first run has started, so the short
    // pause after it is what actually lets a crash show up (measured locally:
    // without it the exception box was not there yet when it was counted).
    await statusWidget.waitFor({ state: "hidden", timeout: 60_000 }).catch(() => {});
    await page.waitForTimeout(3_000);
    // Danach ans Ende scrollen (lazy Inhalte, Fehlerbox unter einem Expander) und höchstens ~20 s auf ein erneutes Rechnen warten.
    await scrollToEnd(appFrame, page);
    await statusWidget.waitFor({ state: "hidden", timeout: 20_000 }).catch(() => {});
    const scriptError = await findScriptError(appFrame);
    if (scriptError) return { ok: false, kind: "skriptfehler", detail: scriptError };
    console.log(`OK   ${url}`);
    return { ok: true };
  } catch (err) {
    return { ok: false, kind: "unklar", detail: err.message.split("\n")[0] };
  } finally {
    await page.close();
  }
}

// Runs `worker` over `items` with at most `limit` in flight at once - plain
// sequential processing stopped fitting the job's time budget once the
// portfolio grew past ~30 demos (each sleeping demo can take over a minute
// to wake), so a handful run concurrently instead.
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function runNext() {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runNext));
  return results;
}

// First pass at a moderate concurrency, then up to two retry passes run
// fully SEQUENTIALLY (one at a time). The first cut of this fix ran retries
// at concurrency 3 and still saw the same handful of demos fail both times,
// every time - evidence pointing at several simultaneous cold boots
// contending for something on Streamlit Community Cloud's side (shared
// free-tier build/boot capacity for the account, not just CI-runner
// resources), rather than plain slowness: manually waking one of those
// exact demos in isolation took well under 30s. Retrying one-at-a-time
// removes that contention as a variable for whichever demos are already
// struggling.
// KEEP_ALIVE_CONCURRENCY=<n>: gleichzeitige Besuche im ersten Durchgang (Standard 4). Der Weck-Lauf setzt 10: ein Kaltstart dauert
// 30 bis 60 s und besteht fast nur aus Warten auf die Cloud, bei 150 Schlafenden brauchte der Durchgang mit 4 etwa 30 Minuten.
const CONCURRENCY = Math.max(1, Number.parseInt(process.env.KEEP_ALIVE_CONCURRENCY ?? "", 10) || 4);
// KEEP_ALIVE_BUDGET_MIN=<Minuten>: nach dieser Zeit werden keine neuen Demos mehr begonnen und keine Wiederholungsdurchgänge mehr
// gestartet; was dann noch offen ist, steht als Fehler mit Hinweis im Protokoll. So endet ein Lauf mit Ergebnis (und Issue) statt vom
// Zeitlimit des Jobs abgebrochen zu werden (3. November 2026: fünf Stunden Laufzeit, Abbruch, kein Protokoll). 0 = ohne Grenze.
const BUDGET_MS = (Number.parseFloat(process.env.KEEP_ALIVE_BUDGET_MIN ?? "") || 0) * 60_000;
const startedAt = Date.now();
const overBudget = () => BUDGET_MS > 0 && Date.now() - startedAt > BUDGET_MS;
const MAX_ATTEMPTS = Math.max(1, Number.parseInt(process.env.KEEP_ALIVE_ATTEMPTS ?? "", 10) || 3);

// Playwright's default headless Chromium sets navigator.webdriver = true and
// carries an "automated" flag Chrome itself exposes - a well-known signal
// some platforms use to throttle or silently ignore actions from automated
// browsers. Manually re-testing one of the demos that consistently failed
// here (in an ordinary, non-automated browser) woke it in well under a
// minute, so this is a real candidate, not a shot in the dark - these
// settings are the standard, safe way to stop announcing "I'm a bot" for
// what is legitimately just visiting our own demos to keep them warm.
const browser = await chromium.launch({
  args: ["--disable-blink-features=AutomationControlled"],
});
const context = await browser.newContext({
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
});
await context.addInitScript(() => {
  Object.defineProperty(navigator, "webdriver", { get: () => undefined });
});

// Hänger der Cloud abfangen (gemessen 2026-11-04, nicht an unseren Demos, nicht an der Last): Streamlit 1.66 lädt über 100 kleine
// Frontend-Chunks (/~/+/static/js/*.js, /-/build/assets/*.js), und jede siebte bis dritte Anfrage der Cloud-Weiterleitung bleibt 40 bis
// 60 s hängen und endet mit HTTP 500 (dieselbe Datei kommt bei der nächsten Anfrage nach 0,3 s). Ein Browser wiederholt ein fehlgeschlagenes
// Modul nicht: der App-Rahmen blieb leer, kein einziger Besuch war ein OK, die Läufe dauerten über 5 Stunden. Deshalb holt der Lauf diese
// Dateien selbst: nach ASSET_TIMEOUT_MS abbrechen, bei Zeitablauf oder 5xx bis zu ASSET_TRIES-mal neu anfragen, erst dann das Ergebnis
// an den Browser geben. WebSocket (die eigentliche Sitzung) und alle anderen Anfragen laufen unverändert.
const ASSET_TIMEOUT_MS = 8_000;
const ASSET_TRIES = 6;
await context.route(/\/(~\/\+\/static|-\/build)\//, async (route) => {
  let last = null;
  for (let i = 0; i < ASSET_TRIES; i++) {
    try {
      const res = await route.fetch({ timeout: ASSET_TIMEOUT_MS });
      if (res.status() < 500) return await route.fulfill({ response: res });
      last = res;
    } catch {
      // Zeitablauf oder Verbindungsfehler: nächster Versuch (auch wenn die Seite inzwischen geschlossen wurde, dann endet die Schleife folgenlos)
    }
  }
  try {
    if (last) await route.fulfill({ response: last });
    else await route.abort();
  } catch {
    // Seite schon geschlossen
  }
});

// Letztes Ergebnis je Adresse. Die FAIL-Zeilen gehen auf stdout (nicht stderr): `portfolio_ops` liest stdout, und im Workflow
// ist `2>&1` gesetzt, dort ändert sich nichts. Format: "FAIL <url>: skriptfehler: <erste Fehlerzeile>" bzw. "nicht-gefunden: ..." bzw.
// bei unklaren Fällen die Meldung selbst (Zeitlimit o. ä.).
const resultByUrl = new Map(urls.map((url) => [url, { ok: false, kind: "unklar", detail: "nicht besucht" }]));
let pending = [...urls];

for (let attempt = 1; attempt <= MAX_ATTEMPTS && pending.length > 0; attempt++) {
  if (attempt > 1 && overBudget()) {
    console.log(`\nZeitbudget von ${BUDGET_MS / 60_000} Minuten aufgebraucht, keine weiteren Durchgänge für ${pending.length} Demo(s).`);
    break;
  }
  const concurrency = attempt === 1 ? CONCURRENCY : 1;
  if (attempt > 1) {
    console.log(`\nAttempt ${attempt}/${MAX_ATTEMPTS}, one at a time, for ${pending.length} demo(s): ${pending.join(", ")}`);
  }
  const results = await mapWithConcurrency(pending, concurrency, (url) =>
    overBudget() ? { ok: false, kind: "unklar", detail: "nicht besucht: Zeitbudget des Laufs aufgebraucht" } : visit(context, url),
  );
  const stillFailing = [];
  pending.forEach((url, i) => {
    const result = results[i];
    resultByUrl.set(url, result);
    if (result.ok) return;
    console.log(`FAIL ${url}: ${result.kind === "unklar" ? result.detail : `${result.kind}: ${result.detail}`}`);
    // Eine sichtbare Fehlerbox bzw. eine unbekannte Adresse ändert sich beim zweiten Besuch nicht: kein erneuter Durchgang.
    if (!FINAL_KINDS.has(result.kind)) stillFailing.push(url);
  });
  pending = stillFailing;
}

await browser.close();

const failedUrls = urls.filter((url) => !resultByUrl.get(url).ok);
if (jsonOut) {
  const rows = urls.map((url) => {
    const r = resultByUrl.get(url);
    return { url, klasse: r.ok ? "ok" : r.kind, detail: r.ok ? "" : r.detail };
  });
  writeFileSync(jsonOut, JSON.stringify(rows, null, 2), "utf8");
}
console.log(`\n${urls.length - failedUrls.length}/${urls.length} demos reachable.`);
if (failedUrls.length > 0) {
  console.log(`Still failing after ${MAX_ATTEMPTS} attempts: ${failedUrls.join(", ")}`);
  process.exit(1);
}
