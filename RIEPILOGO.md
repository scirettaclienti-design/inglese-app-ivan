# Headless English Voice Tutor — Stato del progetto

**Owner**: Ivano Sciretta (AI SPACE / iSpace.works)
**Path locale**: `/Users/mac2023ivanosciretta/inglese app ivan`
**Repo**: `scirettaclienti-design/inglese-app-ivan` (branch `main`)
**Deploy**:
- Frontend PWA: Vercel (build statico da `public/`)
- Backend Node.js: Render (free tier, sleep 10 min)
- URL live: https://inglese-app-ivan.onrender.com

## Obiettivo prodotto

PWA hands-free su iPhone — Ivano cammina con telefono in tasca, schermo bloccato, e tiene una conversazione vocale in inglese B2/intermediate con un tutor. Bilingue: se Ivano parla italiano il tutor risponde in italiano (breve fix + spinta verso EN). Memoria persistente per consolidamento vocabolario nei giorni successivi.

## Stack

| Layer | Tecnologia |
|---|---|
| STT | Deepgram (modello `nova-3`, `language=multi`) |
| LLM | OpenAI GPT-4o (streaming) |
| TTS | OpenAI tts-1 (voce `alloy`, PCM 24kHz → resample 16kHz, speed 0.88) |
| Transport | WebSocket (`ws` server-side, native browser client) |
| Frontend | HTML/CSS/JS vanilla + AudioContext + ScriptProcessorNode (deprecato, da migrare) |
| Memoria | `memory/db.json` (schema attuale piatto, da evolvere) |
| Email reports | nodemailer / Resend (opzionale, configurabile via env) |

## Mappa file chiave

```
inglese app ivan/
├── server.js                  # WS orchestrator + heartbeat ping/pong + barge-in abort
├── config.js                  # env vars (OPENAI_API_KEY, DEEPGRAM_API_KEY, ...)
├── package.json               # deps: ws, express, node-fetch, dotenv, nodemailer
├── public/
│   ├── app.js                 # client: mic capture, VAD, audio playback, visibility recovery
│   ├── index.html             # PWA shell
│   ├── style.css              # glassmorphic UI
│   ├── sw.js                  # service worker (PWA install)
│   └── manifest.json
├── services/
│   ├── deepgram.js            # STT client + KeepAlive 3s + auto-reconnect 300ms
│   ├── openai.js              # GPT-4o stream + chunk-streaming TTS + system prompt
│   └── email.js               # session report dispatch
├── memory/
│   ├── db.json                # errori grammaticali + vocabolario suggerito (schema piatto, V1)
│   └── projects.md            # contesto dei progetti business di Ivano (Dove Vai, Seanfinity, ...)
└── scratch/                   # script personali, NON in produzione
```

## Cronologia bug risolti (commit chain)

Tutti su `main`, push-ati in ordine cronologico:

| Commit | Tema |
|---|---|
| `8703775` | Chunk-streaming TTS su `[.?!]` + turn-taking mirroring + protocollo half-duplex (`server_speaking`/`server_done`/`user_listening`) |
| `1071b25` | Deepgram KeepAlive + auto-reconnect, barge-in con AbortController nativo, system prompt cap 15 parole + esempi personal-trainer |
| `25c30e1` | Deepgram `language=en` strict + WS ping/pong heartbeat + `visibilitychange` recovery |
| `96a79fd` | Rollback a `language=multi` (necessario per IT), KeepAlive 5s→3s, reconnect 800→300ms, heartbeat tollera 2 pong mancati |
| `2a19a9f` | Risolta contraddizione nel system prompt: regola 15 parole vs ≤25 IT confliggevano, ora 15 è default e bilingue è deroga esplicita fino a 30 parole |
| `d117fec` | Upgrade Deepgram nova-2 → `nova-3` (discriminazione EN/IT migliorata) + sezione STT robustness nel prompt (recupera input italiano misclassificato come spagnolo) |

## Architettura logica (pipeline conversazione)

```
[Mic iPhone] → ScriptProcessor 4096 → PCM16 16kHz → WS binary
   ↓
[server.js] → deepgram.sendAudio() → Deepgram live STT
                                       ↓ (is_final)
                                    transcript JSON → client log + processUserText(text)
                                       ↓
                                    GPT-4o stream (con AbortSignal)
                                       ↓
                                    buffer → regex [.?!] → enqueueSentence()
                                       ↓
                                    OpenAI TTS in parallelo, audioChain ordinato
                                       ↓
                          server_speaking JSON → audio chunks → server_done JSON
                                       ↓
                          client → playBinaryAudioChunk → AudioContext source.onended
                                       ↓
                          checkListeningTransition → user_listening JSON → mic riarmato
```

Eventi WS:
- Client → Server: `start`, `stop`, `user_interrupted`, `user_listening`, `test_chat`
- Server → Client: `status`, `transcript`, `server_speaking`, `server_done`, `summary`, `error`
- Heartbeat: server `ws.ping()` ogni 15s, client browser auto-pong

## Stato attuale e problemi aperti

### Risolti e stabili
- Latenza primo chunk audio < 500ms (chunk-streaming TTS).
- Turn-taking: risposte 15 parole default, no monologhi.
- Barge-in: VAD lato client (RMS > 14 per 250ms continui) → stoppa audio + manda `user_interrupted` → server aborta GPT+TTS.
- Mic blocco al 2° turno: risolto via Deepgram KeepAlive (era idle timeout).
- WebSocket NAT drop: heartbeat ping/pong 15s.
- `visibilitychange`: recovery automatica su ritorno foreground.

### In verifica (status: testing dopo `d117fec`)
- **Comprensione italiano**: Deepgram nova-2 con `language=multi` confondeva IT con ES su frasi medie. Upgrade a `nova-3` + recovery prompt lato GPT-4o. Da validare con test vocale dell'utente.
- **Freeze sporadico al 2° turno**: irrisolto. Senza log Render del momento esatto non è isolabile. Possibili cause: throttling iOS background, Deepgram reconnect window 300ms, race condition nel buffer audio.

### Non ancora affrontati (roadmap)
- `memory/db.json` schema evoluto con `mastery_level`, `next_inject_at`, spaced repetition (B1+B2+B3 del report strategico). PR singola pianificata, ~2-3h di lavoro.
- AudioWorklet refactor (sostituisce ScriptProcessorNode deprecato + sposta VAD su audio thread non throttled da iOS). ~3-4h.
- Service Worker keep-alive WebSocket (utilità marginale, in fondo alla coda).
- Sessione streak / engagement nel `session_meta` del db.

## Vincoli non negoziabili

1. **Costi**: free/cheap tier (Render free, Vercel free, Deepgram pay-as-you-go, OpenAI pay-as-you-go).
2. **Hands-free**: telefono in tasca con schermo bloccato, sessioni 20-30 min.
3. **Latenza percepita**: < 500ms tra fine input utente e primo chunk audio risposta.
4. **Persistenza didattica**: il db.json deve trasformarsi da archivio passivo a sistema di immersione attiva (vocabolario rinforzato per spaced repetition).

## Come testare

1. Apri https://inglese-app-ivan.onrender.com su Safari iPhone.
2. Attendi ~10s che Render scaldi (cold start).
3. Tap sul pulsante centrale per iniziare sessione.
4. Casi di test:
   - **Inglese rilassato**: "Hi, how are you?" → risposta breve EN.
   - **Italiano**: "Come si dice 'mi piace camminare'?" → risposta IT + domanda EN forzata.
   - **Domanda meta**: "Spiegami la differenza tra in e on" → spiegazione IT + esercizio EN.
   - **Errore EN**: "I goed to Mykonos" → correzione IT breve + "try again: where did you go?".
   - **Barge-in**: mentre il tutor parla, parla forte sopra → la voce deve tagliarsi entro 250ms.

## Workflow Git

- Branch unico: `main`.
- Push diretto a origin (no PR review interno, è progetto personale).
- Render fa deploy automatico su push.
- Commit message format: `Fix: ...` o `Feat: ...` + breve descrizione tecnica.
- Co-author: Claude Opus 4.7 (1M context) — trailer aggiunto automaticamente.

## Diagnostica veloce

| Sintomo | Prima ipotesi | Dove guardare |
|---|---|---|
| Tutor non parla (testo OK, audio assente) | TTS API error o WS chiuso | Render log: `TTS error for sentence chunk`. Client console: `WebSocket closed`. |
| 2° turno muto | Deepgram morto + reconnect fallito | Render log: `Deepgram connection closed` + `Auto-reconnecting Deepgram`. |
| Italiano trascritto in spagnolo | Deepgram multi confonde IT/ES | Provare nova-3 (già fatto). Fallback: dual-stream EN+IT. |
| Risposta troppo lunga | System prompt non vincolante | Tagliare HARD LIMITS, ridurre cap a 12 parole. |
| Latenza > 1s sul primo audio | TTS streaming non parte | Controllare in `server.js` che `enqueueSentence` venga chiamato sulla prima `[.?!]`. |
| Mic non riarma dopo TTS | `server_done` non arrivato o `serverDoneSpeaking` non flippato | Client console: cercare log `[Visibility]` o controllare `serverDoneSpeaking` in DevTools. |

## Riferimenti

- Dossier architetturale originale: `/Users/mac2023ivanosciretta/Downloads/Headless_Voice_Tutor_Architecture_v2 (1).pdf`
- Memoria didattica utente: `memory/db.json` + `memory/projects.md`
- File di sessione resume: `RESUME_PROMPT.txt` (paste-and-go per nuova chat Claude)
