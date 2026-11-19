# Privacy Policy: Science Fact Checker

_Last updated: November 18, 2026_

Science Fact Checker is a Chrome extension that runs entirely in your browser. **There is no
Science Fact Checker server.** The developer does not receive, store or see your API keys, the
pages you check, or the results.

## What the extension stores (on your device only)
- Your settings and API keys (Anthropic or OpenAI, and optionally OpenAlex and Semantic Scholar),
  in Chrome's local extension storage. They are not synced to your Google account.
- Results of recent checks (claims, verdicts and paper references), so a repeated check is free.
  They expire after 7 days, and you can clear them in settings.

## What is sent, and where
Only when you start a check:
| Sent to | What | Why |
|---|---|---|
| Your AI provider (api.anthropic.com or api.openai.com) | Your AI key; the page text, selected text, video captions or uploaded file you chose to check | To find claims, write search queries and judge the evidence; for OpenAI, to transcribe audio |
| OpenAlex (api.openalex.org) | Short search queries derived from the claims; your OpenAlex key if set | To find research papers |
| Semantic Scholar (api.semanticscholar.org) | The same search queries; your Semantic Scholar key if set | To find research papers |

Each provider handles that data under its own privacy policy. Your AI key is sent only to the
AI provider you chose, never to OpenAlex, Semantic Scholar or anyone else.

## What is not collected
No analytics, tracking, advertising, or browsing history. The extension reads a page only when
you click a check button or use the right-click menu on that page.

## Permissions
- **Read and change data on websites:** to read the article or captions you ask to check, and
  to highlight claims on the page.
- **Side panel, storage, context menus, scripting:** to show results, keep your settings,
  add the right-click "Fact-check selected text" option, and run on the page you're viewing.

## Contact
Open an issue at https://github.com/wspicer/science-fact-checker
