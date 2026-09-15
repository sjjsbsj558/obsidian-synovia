# Synovia

Synovia is a local-first Obsidian desktop plugin for turning notes and selected source material into evidence-backed opinions.

## What It Does

- Ask a question over the current Markdown vault.
- Retrieve relevant notes and inspect the reasoning, evidence, tensions, and open questions.
- Save reviewed opinions without overwriting original notes.
- Turn selected note text into a new question with `用选区形成观点`.
- Organize generated material under `Wiki/Resources`, `Wiki/Evidence`, `Wiki/Knowledge`, `Wiki/Comparisons`, and `Wiki/Topics`.
- Keep incomplete or failed extraction visible instead of claiming the vault is fully covered.

Synovia supports existing whole-vault extraction, search, topic, and Zhihu workflows as compatibility paths. The primary workflow is the Agent-assisted opinion workbench.

## Requirements

- Obsidian desktop `1.11.4` or newer.
- Node.js `22.17` or newer for building from source.
- A Chat Completions-compatible model endpoint is optional. Remote model calls are opt-in.
- Zhihu features using `知乎 CLI / Skill` require the official Zhihu Skill and its CLI to be installed on the same device.

## Install From Release

1. Download `Synovia-0.2.1.zip` from the GitHub Release.
2. Extract it into your vault at `.obsidian/plugins/synovia`.
3. In Obsidian, reload the plugin or restart Obsidian.
4. Open Synovia and configure the model endpoint only if you need Agent-assisted analysis.

The extracted plugin directory must contain `main.js`, `manifest.json`, `styles.css`, and the `skills/obsidian-markdown` directory.

For Zhihu CLI features on a new device, install and authorize the official Zhihu Skill on that device first. Keep the Synovia setting `知乎 CLI 命令` as `zhihu-cli`; the plugin discovers the device-local CLI automatically and does not carry another computer's absolute path or credentials.

## Build From Source

```bash
npm ci
npm run check
npm run package
```

The packaged plugin is written to `dist/synovia`. To watch the source during development:

```bash
npm run dev
```

`npm run check` runs the offline test suite, TypeScript checks, and the production build.

## Data And Privacy

- Original notes are never overwritten by automatic writes.
- Model requests include the bundled Obsidian Markdown rules and only the note content needed for the active workflow.
- Remote operations require explicit configuration and opt-in.
- `extraction-jobs.json`, `.synovia/ingested-sources.json`, and generated vault data may contain private notes. Do not publish them.
- This repository does not include a private vault, model secret, or runtime credentials.

## Current Limitations

- PDF and DOCX import are not implemented.
- Attachment snapshots are not implemented.
- Search and Zhihu results may be excerpts rather than complete articles.
- A model response is not independent fact-checking; evidence links and source completeness remain visible for review.

## Copyright And License

Copyright (c) 2026 Synovia contributors.

This project is released under the GNU General Public License v3.0. Redistribution and modified versions must retain the copyright and license notices, provide the corresponding source as required by GPL-3.0, and keep derivative distributions under compatible GPL terms. See [`LICENSE`](LICENSE).
