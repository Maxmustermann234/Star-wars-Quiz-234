# Star-Wars-Quiz (Episode IV–VI) – sprachgesteuert

Ein Quiz für 1–4 Spieler, das komplett per Sprache läuft: Das Spiel liest vor (SpeechSynthesis) und hört zu (SpeechRecognition). Nach dem Klick auf **„Spiel starten“** braucht ihr weder Maus noch Tastatur.

## Am einfachsten: online über GitHub Pages (auch iPad)

1. Alle Dateien (`index.html`, `style.css`, `game.js`, `questions.json`, `.nojekyll`) liegen im Hauptordner des Repositorys.
2. Auf github.com im Repository **Settings → Pages** öffnen.
3. Unter **Branch** `main` und `/ (root)` wählen und auf **Save** tippen.
4. Nach ungefähr einer Minute ist das Spiel erreichbar unter `https://BENUTZERNAME.github.io/REPOSITORY-NAME/`.

GitHub Pages läuft über HTTPS, deshalb funktioniert dort auch der Mikrofonzugriff.

### Browser

- **iPad/iPhone:** Nimm **Safari**. Chrome auf iOS unterstützt die Spracherkennung voraussichtlich nicht.
  - Unter *Einstellungen → Allgemein → Tastatur* die **Diktierfunktion** einschalten.
  - Beim ersten Start den Mikrofonzugriff erlauben.
- **Computer:** Nimm **Google Chrome**.
- In beiden Fällen braucht ihr eine **Internetverbindung**, weil die Spracherkennung über die Server von Apple bzw. Google läuft.

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

Danach in Chrome <http://localhost:8000> öffnen und den Mikrofonzugriff erlauben.

## So wird gespielt

1. **Spiel starten** klicken.
2. **Anmeldung:** Jeder Spieler sagt nach dem Signalton seinen Namen. Das Spiel liest ihn vor und fragt nach: „ja“ bestätigt, „nein“ wiederholt die Eingabe. Mit **„fertig“** endet die Anmeldung vorzeitig. Nach 4 Spielern geht es automatisch weiter.
3. **Fragerunde:** Reihum bekommt jeder Spieler 6 Fragen.
   - Freie Antwort richtig: **5 Punkte**. Falsch: 0 Punkte, und die Frage ist für diesen Spieler vorbei.
   - **„weiß nicht“** (auch „keine Ahnung“ oder „passe“): Das Spiel liest die Antworten A, B und C vor und zeigt sie an. Ihr antwortet mit **„A“, „B“ oder „C“**. Richtig: **2 Punkte**.
   - **„wiederholen“**: Das Spiel liest die Frage noch einmal vor.
   - Wurde nichts verstanden, wiederholt das Spiel die Frage freundlich. Klappt es dreimal hintereinander nicht, liest es die drei Antwortmöglichkeiten vor.
4. **Endstand:** Die Punkte werden angesagt und angezeigt. Bei **Gleichstand an der Spitze** bekommen die betroffenen Spieler je eine **Stichfrage** nach denselben Regeln. Das wiederholt sich, bis ein Sieger feststeht.
5. **Siegerbildschirm:** Der Name des Gewinners erscheint groß, und ein Frachter fliegt durchs Bild.

Tipp: Sprecht erst nach dem kurzen Signalton. Das rote Mikrofon-Symbol zeigt, dass gerade zugehört wird.

## Testmodus ohne Mikrofon

`…/?test` an die Adresse anhängen, also zum Beispiel <http://localhost:8000/?test> oder `https://BENUTZERNAME.github.io/REPOSITORY-NAME/?test`.

Im Testmodus werden Antworten in ein Textfeld getippt statt gesprochen, und die Sprachausgabe ist abgeschaltet. Das ist praktisch zum Ausprobieren und Debuggen.

## Dateien

| Datei | Inhalt |
| --- | --- |
| `index.html` | Aufbau der Bildschirme (Start, Spiel, Endstand, Sieger), Frachter als SVG |
| `style.css` | Sternenhimmel-Look, gelbe Schrift, Lichtschwert-Rahmen, Animationen |
| `game.js` | Spiellogik, Sprachein- und -ausgabe, tolerante Antwortauswertung, Sternenfeld |
| `questions.json` | 50 Fragen und 7 Stichfragen |

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

So wertet das Spiel freie Antworten aus:

- Groß- und Kleinschreibung, Umlaute, Satzzeichen, Artikel und Füllwörter wie „ich glaube“ zählen nicht.
- Zahlwörter werden in Ziffern umgewandelt.
- Kleine Erkennungsfehler sind erlaubt (Levenshtein-Distanz, abhängig von der Wortlänge).

Für ein Spiel mit 4 Spielern braucht ihr mindestens 24 normale Fragen.
