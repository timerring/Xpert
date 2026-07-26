# X One Click Mute

An independently implemented Chrome Manifest V3 extension that adds one-click Mute buttons to posts, user lists, and profiles on X (Twitter), with bulk queues, a local mute ledger, statistics, and backups.

## Features

- Injects one-click buttons into timelines, search results, follower/following lists, notifications, hashtags, communities, engagement lists, and profiles
- Mutes accounts through X's official interface without unfollowing them[^why-mute]
- Drives X's official menus and confirmation dialogs without calling private APIs
- Imports bulk account lists from text, X links, CSV, or JSON
- Processes queued accounts through background profile tabs, with stop, retry, and run-history support
- Stores a Mute ledger for each detected X `@handle`
- Supports ledger search, full JSON exports, selective restore, and local data cleanup
- Stores all extension data in `chrome.storage.local`

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

## Development and Validation

No build step is required; Chrome can load the repository directly.

```bash
node --test
find src -name '*.js' -exec node --check {} \;
```

## Implementation Notes

X is a continuously changing single-page application. The extension prefers relatively stable `data-testid` attributes and URL structures to identify page elements, and uses `MutationObserver` to support infinite scrolling and in-app navigation. Mute actions are still performed by X's own interface, so results, rate limits, and account permissions are determined by X.

This project independently implements publicly described product behavior. It does not contain third-party extension source code, names, icons, or other branded assets.

[^why-mute]: This extension uses Mute because it removes unwanted posts from the timeline without unfollowing the account or disrupting an existing social connection. Block remains the stronger option for safety, harassment, or firm contact boundaries.
[^x-sources]: Sources: X Help Center — [How to mute accounts on X](https://help.x.com/en/using-x/x-mute) and [Blocking on X](https://help.x.com/en/using-x/blocking-and-unblocking-accounts).
