# QuickClip Capture Manager

An Obsidian plugin that renders and manages clips saved by the [QuickClip Capture](https://chromewebstore.google.com/detail/quickclip/edabdpgppnhbogfpdghjekdalmipflel) Chrome extension.

QuickClip Capture is a web clipper built for Obsidian — highlight text, clip full pages, save tweets, PDF excerpts, YouTube timestamps, and images directly into your vault. This plugin handles the Obsidian side: polished reading view cards for every clip type, and a Clip Manager to browse, filter, tag, and annotate everything you've saved.

---

## Requirements

The **QuickClip Capture** Chrome extension must be installed and configured to save clips into your Obsidian vault. Install it from the [Chrome Web Store](https://chromewebstore.google.com/detail/quickclip/edabdpgppnhbogfpdghjekdalmipflel).

---

## Features

### Reading View — Clip Cards

Every clip type is rendered as a polished card in Reading view:

- **Highlights** — collapsible cards with quoted text, source link, tags, captured date, and one-click delete; collapsed by default with a summary header; expand state persisted across sessions
- **Full-page clips** — complete Markdown article with author, publish date, site pill, word count, and a reading progress bar that appears as you scroll
- **YouTube / Vimeo clips** — embedded video player with clickable timestamp chips that seek the video; sortable clip table with per-row delete
- **Tweets** — native Twitter/X embed with badge, date, and delete
- **PDF highlights** — quoted text with source file link and page number; local PDFs open in your default app
- **Images** — inline image with caption and metadata

### Clip Manager

A dedicated panel (accessible from the ribbon or command palette) to browse everything you've clipped:

- Filter by clip format, domain, date range, or whether a note exists
- Inline editing: update tags, add or edit notes, change content type — all written back to the source `.md` file
- Sortable, resizable columns; show/hide and reorder columns to your preference
- Click any clip to open the source file in Reading view, scrolled to that clip
- Delete clips directly from the table

### Settings

- **Callout colors** — customize the accent color for each clip type
- **Row density** — compact, comfortable, or spacious
- **Snippet length**, **date format**, **file path display**, and more
- **Confirm before delete** toggle
- **Auto-open on startup** — open the Clip Manager automatically when Obsidian loads
- **Migration tool** — one-click migration of clips saved in the old format to the current callout structure (shown only when old-format clips are detected)

---

## Installation

### From the Obsidian Community Plugin Browser

1. Open Obsidian → Settings → Community Plugins
2. Search for **QuickClip Capture Manager**
3. Install and enable

### Manual

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/vipsyvipul/QuickClip-Capture-Plugin/releases)
2. Copy all three files into `.obsidian/plugins/quickclip-capture/` inside your vault
3. Enable the plugin in Settings → Community Plugins

---

## Usage

1. Install the QuickClip Capture Chrome extension and point it at your vault folder
2. Clip anything from Chrome — highlights, pages, tweets, PDFs, YouTube timestamps
3. Open the clipped note in Obsidian's **Reading** view to see the rendered cards
4. Open the Clip Manager (ribbon icon or `Cmd/Ctrl+P` → "Open Clip Manager") to browse, tag, and annotate all your clips

---

## Privacy

This plugin reads and writes files only within your local Obsidian vault. It makes no network requests and has no telemetry.

---

## License

MIT — see [LICENSE](LICENSE)
