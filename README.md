# Vault Tab

Un tab **"Vault"** nella barra laterale destra di [DSH](https://npmjs.com/package/@deepseek-ai/dsh):
l'albero di una cartella a scelta, sempre visibile, con anteprima integrata dei file.

Pensato per chi tiene le proprie note (un *second brain*, un vault Obsidian, una
cartella di documenti) e vuole consultarle da **qualsiasi sessione**, indipendentemente
dal workspace aperto in quel momento.

```
┌──────────────────────────────┬──────────────┐
│  sessione di lavoro         │  Vault       │
│  (qualsiasi workspace)      │  ├─ 10-Pro…  │
│                              │  ├─ 20-Areas │
│                              │  └─ …        │
└──────────────────────────────┴──────────────┘
```

## Funzionalità

- 🌳 **Albero di una cartella** nella barra destra, accanto ai file di workspace,
  al terminale e al browser
- 📄 **Anteprima nativa**: un click su un file lo apre nel visualizzatore
  integrato di DSH (testo, codice, Markdown)
- 🧭 **Percorso configurabile dalla GUI**, con effetto immediato: niente file
  di configurazione da modificare, niente riavvii
- 🔒 **Sola lettura**: l'elenco resta confinato alla cartella scelta; il plugin
  non scrive e non modifica nulla
- 🧩 Zero dipendenze pesanti: un unico piccolo bundle

## Requisiti

- DSH con pannello Plugins (GUI web)
- Una cartella da esporre, leggibile dall'utente che esegue DSH

## Installazione

1. Scarica la cartella del plugin in una posizione **definitiva**
   (l'installazione la referenzia in loco: spostarla dopo richiederebbe una
   reinstallazione).
2. Nella GUI di DSH apri il pannello **Plugins** e installa il bundle dalla
   cartella scaricata.
3. Il tab **Vault** compare subito nella barra laterale destra.

## Prima configurazione

Alla prima apertura il plugin usa un percorso predefinito:
una cartella `Vault` nella home dell'utente che esegue DSH.
Se quella cartella non esiste, il tab lo dice chiaramente:

> **Vault not found**
> Pick your folder in Plugins → Vault Tab (field "Vault path"), or create this path.

Hai due strade:

### A. Accettare il default

Crea la cartella indicata nel messaggio (es. `mkdir -p ~/Vault`) e premi
**Reload** sul tab. Fatto.

### B. Scegliere la tua cartella (consigliato)

1. Apri il pannello **Plugins** e seleziona **Vault Tab**.
2. Nel campo **"Vault path"** inserisci il percorso completo della cartella,
   ad esempio `/home/utente/note` oppure `~/note` (la `~` è la home
   dell'utente che esegue DSH).
3. Premi **Save**. Il salvataggio vale da subito.
4. Torna al tab **Vault** e premi **Reload**: l'albero della tua cartella è lì.

Note utili:

- Il percorso deve essere **assoluto** (o iniziare con `~`).
- La cartella deve essere leggibile dall'utente che esegue DSH.
- **Reset** sul campo riporta il plugin al default; la tua scelta resta nel
  profilo DSH, non dentro il pacchetto del plugin.
- Ogni istanza DSH sceglie il proprio percorso: il pacchetto non contiene
  configurazioni.

## Uso

- Cartelle prima dei file, ordine alfabetico; click per espandere/comprimere.
- Click su un file → anteprima nel visualizzatore di DSH.
- **Reload** (icona in alto nel tab) ri-legge la cartella dopo modifiche esterne.
- Nella guida di primo avvio di DSH, Vault compare tra "Workspace files" e
  "Terminale".

## Sicurezza

- Il listing avviene tramite una route locale accessibile **solo** dal sito
  della GUI stessa (nessun accesso esterno, nessun cross-origin).
- Ogni richiesta di elenco è confinata sotto la cartella configurata: non è
  possibile "uscirne" nemmeno con percorsi relativi o symlink.
- Le anteprime seguono i normali permessi di lettura delle sessioni DSH.
- Il plugin non introduce credenziali né telemetria.

## Risoluzione problemi

| Sintomo | Causa probabile | Rimedio |
|---|---|---|
| "Vault not found" | cartella inesistente o non leggibile | crea la cartella o imposta un path corretto nel pannello Plugins |
| Albero non aggiornato | modifiche esterne recenti | premi **Reload** nel tab |
| Cartelle vuote inespandibili | permessi sui sotto-percorsi | verifica i permessi di lettura |

## Licenza

Vedi il repository di provenienza.
