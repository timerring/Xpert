# X One Click Block

An independently implemented Chrome Manifest V3 extension that adds one-click Block and Mute buttons to posts, user lists, and profiles on X (Twitter), with bulk queues, local action ledgers, statistics, and backups.

## Features

- Injects one-click buttons into timelines, search results, follower/following lists, notifications, hashtags, communities, engagement lists, and profiles
- Lets you choose Block or Mute as the default action
- Drives X's official menus and confirmation dialogs without calling private APIs
- Imports bulk account lists from text, X links, CSV, or JSON
- Processes queued accounts through background profile tabs, with stop, retry, and run-history support
- Stores separate Block and Mute ledgers for each detected X `@handle`
- Supports ledger search, full JSON exports, selective restore, and local data cleanup
- Stores all extension data in `chrome.storage.local`

## Local Installation

1. Open `chrome://extensions`.
2. Enable **Developer mode** in the top-right corner.
3. Click **Load unpacked**.
4. Select this repository's directory.
5. Open or refresh [X](https://x.com).

Before using the bulk queue, make sure you are signed in to X. The queue creates inactive temporary tabs and closes each one after processing the account.

## Development and Validation

No build step is required; Chrome can load the repository directly.

```bash
node --test
find src -name '*.js' -exec node --check {} \;
```

## Implementation Notes

X is a continuously changing single-page application. The extension prefers relatively stable `data-testid` attributes and URL structures to identify page elements, and uses `MutationObserver` to support infinite scrolling and in-app navigation. Block and Mute actions are still performed by X's own interface, so results, rate limits, and account permissions are determined by X.

This project independently implements publicly described product behavior. It does not contain third-party extension source code, names, icons, or other branded assets.
