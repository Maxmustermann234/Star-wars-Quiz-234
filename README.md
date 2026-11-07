# Star-Wars-Quiz (Episode IV–VI) – sprachgesteuert

Ein Quiz für 1–4 Spieler zu Episode IV–VI. Das Spiel liest Fragen und Rückmeldungen vor. Geantwortet wird **per Tastatur** oder **per Sprache**: Mikrofon antippen und sprechen. Ein Mikrofon ist nicht nötig, das Spiel läuft auch komplett mit Tastatur, zum Beispiel auf dem iPad.

## Am einfachsten: online über GitHub Pages (auch iPad)

1. Alle Dateien (`index.html`, `style.css`, `game.js`, `questions.json`, `.nojekyll`) liegen im Hauptordner des Repositorys.
2. Auf github.com im Repository **Settings → Pages** öffnen.
3. Unter **Branch** `main` und `/ (root)` wählen und auf **Save** tippen.
4. Nach ungefähr einer Minute ist das Spiel erreichbar unter `https://BENUTZERNAME.github.io/REPOSITORY-NAME/`.

GitHub Pages läuft über HTTPS, deshalb funktioniert dort auch der Mikrofonzugriff.

### Browser

- Das Spiel funktioniert in jedem aktuellen Browser, auch in **Safari auf dem iPad**.
- Ohne Mikrofon-Freigabe wird einfach getippt.
- **Spracheingabe (optional):** Chrome am Computer oder Safari auf iPad/iPhone mit eingeschalteter **Diktierfunktion** und Siri. Dafür ist eine Internetverbindung nötig.
- Ist die Spracherkennung auf dem Gerät gesperrt, blendet das Spiel den Mikrofon-Knopf aus und zeigt einen Hinweis.

## Alternativ: lokal am Computer starten

Mikrofonzugriff gibt es nur über `https://` oder `http://localhost`. Außerdem lädt das Spiel `questions.json` per `fetch`. Deshalb funktioniert es nicht, wenn man `index.html` direkt als Datei öffnet. Im Spielordner **eine** dieser Varianten ausführen:

**Python 3** (unter Windows heißt der Befehl `python`, auf dem Mac `python3`):

```bash
python3 -m http.server 8000
```

**Node.js**

```bash
npx serve -l 8000
```

**VS Code**: Erweiterung „Live Server“ installieren, dann Rechtsklick auf `index.html` → „Open with Live Server“.

Danach im Browser <http://localhost:8000> öffnen.

## So wird gespielt

1. **Anzahl wählen:** Tippe auf **1, 2, 3 oder 4**, je nachdem, wie viele Spieler mitspielen.
2. **Namen eintippen:** Es erscheinen passend viele Namensfelder. Ein leer gelassenes Feld heißt im Spiel einfach „Spieler 2“ usw. Danach **Spiel starten** tippen.
3. **Fragerunde:** Reihum bekommt jeder Spieler 6 Fragen. Das Spiel sagt an, wer dran ist, und liest die Frage vor.
   - Antwort **eintippen** und Enter drücken bzw. **Antworten** tippen. Alternativ auf das **Mikrofon** tippen und sprechen.
   - Freie Antwort richtig: **5 Punkte**. Falsch: 0 Punkte, und die Frage ist für diesen Spieler vorbei.
   - **Weiß nicht → A/B/C** (getippt, gesagt oder als Taste): Es erscheinen drei Möglichkeiten. **A, B oder C** antippen, eintippen oder sagen. Richtig: **2 Punkte**.
   - **Frage wiederholen** liest die Frage noch einmal vor.
4. **Endstand:** Die Punkte werden angesagt und angezeigt. Bei **Gleichstand an der Spitze** bekommen die betroffenen Spieler je eine **Stichfrage** nach denselben Regeln. Das wiederholt sich, bis ein Sieger feststeht.
5. **Siegerbildschirm:** Der Name des Gewinners erscheint groß, und ein Frachter fliegt durchs Bild. **Neues Spiel** führt zurück zum Start. Anzahl und Namen bleiben eingetragen.

**Freihändig spielen (nur Computer):** In Chrome am Computer gibt es auf dem Startbildschirm die Option **„Freihändig spielen“**. Dann hört das Spiel nach jeder Frage automatisch zu (Signalton, rotes Mikrofon). Tippen geht trotzdem jederzeit.

## Testmodus

`?test` an die Adresse anhängen, zum Beispiel <http://localhost:8000/?test>. Dann ist die Sprachausgabe stumm und sofort fertig, und das Mikrofon ist ausgeblendet. Das ist praktisch zum schnellen Durchklicken.

## Dateien

| Datei | Inhalt |
| --- | --- |
| `index.html` | Aufbau der Bildschirme (Start, Spiel, Endstand, Sieger), Frachter als SVG |
| `style.css` | Sternenhimmel-Look, gelbe Schrift, Lichtschwert-Rahmen, Animationen |
| `game.js` | Spiellogik, Sprachausgabe, Eingabe per Tastatur/Mikrofon, tolerante Antwortauswertung, Sternenfeld |
| `questions.json` | 100 Fragen und 7 Stichfragen |
| `fonts/` | Schriften Orbitron und Exo 2 (lokal, SIL Open Font License 1.1) |

## Datenschutz

- Das Spiel läuft komplett im Browser. Es hat **keinen eigenen Server, keine Datenbank, keine Cookies und kein Tracking**. Namen und Punkte bleiben nur bis zum Neuladen der Seite im Speicher des Geräts.
- **Schriften** werden vom selben Server wie das Spiel geladen, nicht von Google.
- **GitHub Pages** (GitHub/Microsoft) speichert beim Aufruf technische Daten wie die IP-Adresse in Server-Logs.
- **Vorlesen:** Das übernimmt die Sprachausgabe des Browsers bzw. Geräts. Auf iPad/iPhone sind das meist Apple-Stimmen direkt auf dem Gerät. In Chrome werden Google-Stimmen bevorzugt, die den Text an Google senden können.
- **Spracheingabe (optional):** Nur wenn jemand aufs Mikrofon tippt (oder „Freihändig“ einschaltet), geht die Aufnahme zur Auswertung an Apple (Safari) bzw. Google (Chrome). Wer tippt, sendet keine Daten.

## Eigene Fragen hinzufügen

`questions.json` enthält zwei Listen: `questions` und `tiebreakers`. Jeder Eintrag hat diesen Aufbau:

```json
{
  "question": "Auf welchem Sumpfplaneten lebt Yoda im Exil?",
  "answer": "Dagobah",
  "alternatives": ["dagoba", "dagobar"],
  "options": { "A": "Dagobah", "B": "Endor", "C": "Hoth" },
  "correct": "A"
}
```

- `answer` ist die richtige Antwort. Das Spiel liest sie vor.
- `alternatives` sind weitere akzeptierte Schreibweisen und typische Erkennungsfehler.
- `options` und `correct` gehören zur Auswahlrunde mit A, B und C.
- `"strict": true` (optional) schaltet die Tippfehler-Toleranz für diese Frage ab. Das ist sinnvoll, wenn sich richtige und falsche Antworten nur in einem Zeichen unterscheiden, z. B. AT-AT/AT-ST oder X-Wing/Y-Wing.

So wertet das Spiel freie Antworten aus (getippt und gesprochen):

- Groß- und Kleinschreibung, Umlaute, Satzzeichen, Artikel und Füllwörter wie „ich glaube“ zählen nicht.
- Zahlwörter werden in Ziffern umgewandelt. **Zahlen müssen immer exakt stimmen**, also ist „500 Jahre“ nicht „900 Jahre“.
- Kleine Erkennungsfehler sind erlaubt (Levenshtein-Distanz, abhängig von der Wortlänge).
- In der A/B/C-Runde zählt ein exakt genannter Optionstext vor dem Buchstaben. „C-3PO“ wählt also die Option C-3PO, nicht den Buchstaben C.

Für ein Spiel mit 4 Spielern braucht ihr mindestens 24 normale Fragen.
