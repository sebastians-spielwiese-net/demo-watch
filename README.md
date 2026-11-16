# demo-watch (Spielwiese)

Geplante Prüfläufe für die Demos auf [sebastians-spielwiese.net](https://sebastians-spielwiese.net). Das Repo ist öffentlich, weil die
GitHub-Actions-Minuten dort kostenlos sind; es enthält keinen eigenen Code außer dem Besuchsskript. Es ist die kleine Schwester von
`demo-watch` der Hauptseite (gleiche Skripte und Workflows, zugeschnitten auf drei Apps). Die Streamlit Community Cloud lässt Apps ohne
Besuch einschlafen; diese Läufe öffnen sie in einem echten Headless-Browser und melden Apps, die zwar laden, aber im Skript abgestürzt sind.

| Workflow | Zeitplan | Was er tut |
|---|---|---|
| `keep-alive.yml` | alle 6 Stunden | Öffnet jede Demo in einem Headless-Browser und prüft, dass sie gerendert wird. Sicherheitsnetz neben `wake-sleepers.yml`. |
| `wake-sleepers.yml` | Schleife: ein Lauf arbeitet 4,5 Stunden alle 5 Minuten (nach einem Durchgang mit Schlafenden alle 2) und startet den nächsten selbst; stündlicher Zeitplan als Reserve | Fragt je Demo den Health-Endpunkt ab (`/~/+/_stcore/health`: 200 wach, 400 schläft, weckt nichts) und besucht nur die schlafenden im Browser. GitHub startet geplante Läufe unzuverlässig, daher die selbstfortsetzende Kette (`gh workflow run`, `actions: write`). Anhalten: Workflow deaktivieren. |

Ein Fehlschlag legt ein Issue an (nur eines je Fehlerbild); es schließt sich, sobald ein Lauf wieder grün ist.

**Neue Demo eintragen:** Adresse in `DEMO_URLS` in `.github/scripts/keep-alive.mjs` und in `KEEP_ALIVE_URLS` der beiden Workflows ergänzen.

**Aktuelle Demos:**

- <https://spielwiese-figurenwert.streamlit.app/>
- <https://spielwiese-taktik-muster.streamlit.app/>
- <https://spielwiese-partieformular.streamlit.app/>

GitHub deaktiviert geplante Workflows in öffentlichen Repos nach 60 Tagen ohne Aktivität im Repo. Die selbstfortsetzende Kette zählt dabei nicht
immer als Aktivität; erscheint ein Hinweis auf eine Deaktivierung, die Workflows in den Actions-Einstellungen wieder einschalten.
