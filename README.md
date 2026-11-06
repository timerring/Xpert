# Xpert

An independently implemented Chrome Manifest V3 extension that adds one-click Mute buttons to posts, user lists, and profiles on X (Twitter), with bulk queues, a local mute ledger, statistics, and backups.

See the [Privacy Policy](PRIVACY.md) for details about local data handling and X requests.

## Features

- Injects one-click buttons into timelines, search results, follower/following lists, notifications, hashtags, communities, engagement lists, and profiles
- Mutes accounts using the signed-in X session while preserving follows[^why-mute]
- Offers **Undo** for 10 seconds after a one-click mute; hovering or focusing the prompt keeps it available
- Provides **Unmute** beside each local ledger entry, with progress, error feedback, and removal after X confirms success
- Imports bulk account lists from text, X links, CSV, or JSON
- Processes queued accounts through background profile tabs, with stop, retry, and run-history support
- Stores a Mute ledger for each detected X `@handle`
- Supports ledger search, full JSON exports, selective restore, and local data cleanup
- Stores extension settings and local history in `chrome.storage.local`
- Adds native muted words in batches, with a preview, duplicate detection, pause/resume, and per-word results
- Opens a muted-word draft from text selected in a post, with X's native scope and duration controls
- Reads, searches, edits, and removes words from the signed-in account's native muted-word list

### Why Mute Instead of Block?

| Difference | Mute | Block |
| --- | --- | --- |
| Posts shown in your timeline | Generally hidden | Generally hidden |
| Can the account follow you? | Yes | No; blocking also makes both accounts unfollow each other |
| Can the account interact with your posts? | Yes | No |
| Can the account send you Direct Messages? | Possibly; muting does not change Direct Message permissions | No |
| Will the account know? | No notification, and muting is invisible to the muted account | No notification, but the account can discover the block by visiting your profile |
| Can the account see your public posts? | Yes | **Currently yes**, but it cannot interact with them |
| Best suited for | Noisy or irrelevant content when you do not want to disrupt the relationship | Harassment, malicious interaction, or a clear boundary against contact |

The final row reflects this project's product rationale; the behavior rows are based on X's official documentation.[^x-sources]

## Local Installation

1. Open `chrome://extensions`.
2. Enable **Developer mode** in the top-right corner.
3. Click **Load unpacked**.
4. Select this repository's directory.
5. Open or refresh [X](https://x.com).

Before using the bulk queue, make sure you are signed in to X. The queue creates inactive temporary tabs and closes each one after processing the account.

### Undo a Mute

After clicking Mute, select **Undo** in the confirmation prompt to unmute the account and restore the original post when it is still on the page. Each account has its own prompt. After a prompt expires, open **Mute Ledger** and click **Unmute**. The ledger creates a temporary X profile tab, uses your signed-in session, and closes the tab when finished. Refresh open X pages to update their timelines after using the ledger. Older records saved before the signed-in account was identified offer **Open on X** for unmuting through X's profile menu.

X request failures keep the ledger entry available for retry. Local record failures are reported separately from successful actions on X. **Clear Mute Ledger** only clears local records; use **Unmute** to change the account's status on X.

### Native Muted Words

Open **Muted Words** in the Control Center and connect to your signed-in X account. Paste one word or phrase per line, select **Preview words**, and review the terms and target account before choosing **Apply**. Each batch accepts up to 100 unique phrases of up to 140 Unicode characters each. Spaces inside phrases, Chinese text, hashtags, mentions, and emoji are preserved. Every word is checked against the current X list before adding it. Matching existing words are skipped, keeping their original settings.

Choose Home timeline, notifications, or both. The notification audience can be everyone or people you do not follow. Durations match X: forever, 24 hours, 7 days, or 30 days. When editing an existing word, **Keep current expiry** preserves its current expiry time. X applies these rules to the account; search results can still contain the words. See [X's native muted-word documentation](https://help.x.com/en/using-x/advanced-x-mute-options).

To start from a post, select text within its body and click **Mute word**. Xpert opens a draft in the Control Center for review. Adding the word requires the explicit **Apply** action there.

Batch processing is sequential. An error pauses the batch with its progress retained. After resolving a login or rate-limit issue, resume to reconcile the current X list and continue. Browser restarts leave unfinished work paused for review. Pause takes effect after the current request finishes. The list supports search, editing, and reviewed removal of up to 100 selected words. **Clear batch results** clears the local batch record; the native rules remain on X.

Native word rules live on X. Xpert's JSON backup covers the existing local account ledger and settings; manage native words through **Muted Words** or X's settings. Keep the same X account signed in while a batch is running.

## Development and Validation

No build step is required; Chrome can load the repository directly.

```bash
node --test
find src -name '*.js' -exec node --check {} \;
```

The browser layout regression checks rendered alignment across 46 viewport sizes,
11 CSS zoom levels, and five display densities, plus resizing, animations, themes,
scrolling, native control replacement, and shortcut settings. With Playwright and
its Chromium installed, run:

```bash
node scripts/check-shortcut-layout.cjs
node scripts/check-undo-mute.cjs
node scripts/check-keywords.cjs
```

Set `PLAYWRIGHT_MODULE` to an existing Playwright module path and `CHROME_PATH` to
an existing Chrome executable to use a local browser installation. CSS zoom and
display density checks cover scaling geometry; manual browser zoom and real X
page checks complement this synthetic fixture.

The undo regression uses mocked X requests and Chrome messaging to exercise success,
request failures, retries, rapid clicks, prompt expiry, and the ledger UI without
changing real X accounts.

The keyword regression also uses mocked requests. It checks batch reconciliation,
scope and duration parameters, account changes, partial failures, text selection,
and responsive controls. The native endpoint contract was checked against X's
current muted-word settings page and its loaded client code on November 7, 2026.

## Implementation Notes

X is a continuously changing single-page application. The extension prefers relatively stable `data-testid` attributes and URL structures to identify page elements, and uses `MutationObserver` to support infinite scrolling and in-app navigation. Mute and unmute actions use X's web-session endpoints, so results, rate limits, and account permissions are determined by X. These endpoints and page structures may change. Storage mutations run serially in the extension service worker so concurrent UI and queue operations preserve each other's updates.

Native word requests also require X's current client transaction metadata. A bundled script on X settings pages calls the already-loaded, cached X metadata adapter for four fixed keyword endpoints. It returns only a request identifier to the isolated content script. Account checks, credentials, fixed request URLs, and all batch logic remain in the isolated script and service worker. The adapter uses X's internal module interface; a change to that interface pauses processing with an update/refresh message. Xpert bundles its own code and adds no remote script loader or code evaluator.

This project independently implements publicly described product behavior. It does not contain third-party extension source code, names, icons, or other branded assets.

[^why-mute]: This extension uses Mute because it removes unwanted posts from the timeline without unfollowing the account or disrupting an existing social connection. Block remains the stronger option for safety, harassment, or firm contact boundaries.
[^x-sources]: Sources: X Help Center — [How to mute accounts on X](https://help.x.com/en/using-x/x-mute) and [Blocking on X](https://help.x.com/en/using-x/blocking-and-unblocking-accounts).
