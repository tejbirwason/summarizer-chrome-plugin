## Architecture Overview

Legend: dotted arrows indicate streaming updates

```mermaid
flowchart LR
  %% Subgraphs for clarity
  subgraph Browser[Chrome Browser]
    subgraph Extension[Chrome Extension MV3]
      CJS[content.js<br/>Global Content Script]
      YTJS[youtube-content.js<br/>YouTube Content Script]
      BG[background.js<br/>Service Worker]
      UI[Overlay UI<br/>Dark Themed Panel]
    end
    subgraph Messaging[Chrome Messaging]
      MSG[sendMessage / Port]
      NM[Native Messaging]
    end
  end

  subgraph NativeHost[Native Host]
    MAN[com.ytsummary.json<br/>Native Host Manifest]
    PY[yt-summary.py<br/>Python process]
  end

  subgraph APIs[External AI & Data]
    OAI[OpenAI o3 API]
    CLAUDE[Claude API]
    YTAPI[YouTube Transcript API]
  end

  %% Selected Text: Summarize & Draft
  CJS -->|summarizeSelection| BG
  CJS -->|draftResponse| BG

  BG -->|stream request| OAI
  OAI -.->|stream chunks| BG
  BG -.->|stream updates| CJS
  CJS -.->|append text| UI

  BG -->|stream request| CLAUDE
  CLAUDE -.->|stream chunks| BG
  BG -.->|stream updates| CJS
  CJS -.->|append text| UI

  %% YouTube Transcript Summarization
  YTJS -->|summarizeVideo| BG
  BG -->|video_id via Native Messaging| PY
  MAN --- PY
  PY -->|fetch transcript| YTAPI
  YTAPI --> PY
  PY --> BG
  BG -->|stream request| OAI
  OAI -.->|stream chunks| BG
  BG -.->|stream updates| YTJS
  YTJS -.->|append text| UI
```

- content.js shows FABs, sends messages, and renders streaming results safely via textContent.
- youtube-content.js detects video pages and initiates transcript summarization.
- background.js orchestrates API calls (OpenAI o3, Claude) and native messaging to yt-summary.py.
- yt-summary.py fetches transcripts with youtube-transcript-api and returns JSON over the native messaging protocol.
