# Xpert Privacy Policy

**Effective date:** November 7, 2026

Xpert is a Chrome extension that adds controls for muting accounts and words on X and a local library of the user's own posts. This Privacy Policy explains what data Xpert handles, why it is needed, where it is stored, and the choices available to users.

Xpert is an independent project and is not affiliated with, endorsed by, or sponsored by X Corp.

## Data Xpert Handles

Xpert handles only the data needed to provide its user-facing muting and local record-keeping features:

- **X account identifiers:** X handles, the currently signed-in X handle, and numeric X user identifiers displayed on supported X pages, returned by X after a requested action, or supplied by the user. Numeric identifiers allow Unmute to target the same account after a handle change.
- **Authentication information:** Xpert reads X's `ct0` CSRF token from the current X page when performing an account action or reading or changing muted words requested by the user. Native word operations also compare the `twid` account marker, when available, to detect a session change. The session snapshot is held in temporary page memory for the operation and is kept out of Xpert's local records and messages.
- **X page context and website content:** Xpert reads limited information from supported `x.com` and `twitter.com` pages, including the current route and account identifiers present in the page, to place Mute controls beside the correct accounts.
- **User activity related to Xpert:** requested mute actions, timestamps, action sources, bulk queue status, and bulk run history.
- **Extension settings and user-provided data:** button-placement preferences, queue delay settings, and X handles or X links entered or imported by the user.
- **Muted words:** words or phrases entered by the user, text explicitly selected within a post for a muted-word draft, the native muted-word list returned by X, scope and duration choices, and local batch progress. Selected text is processed locally until the user chooses to add the word on X.
- **Imported post archives:** account identifiers and profile labels, post identifiers, full text, timestamps, post types, reply and quote references, media links, and import reports from files explicitly selected by the user in **My Posts**. The importer reads supported account and post data files. Other archive sections, including Direct Messages and address books, are excluded from the post library.

My Posts stores user-selected post text locally, which may contain personal information included in those posts. The importer excludes Direct Messages, address books, and location metadata.

## How the Data Is Used

Xpert uses this data only to:

- display Mute controls on supported X pages;
- send a mute or unmute request to X when the user explicitly requests it;
- process user-created bulk mute queues;
- read and manage X's native muted words and process user-created word batches;
- maintain a local mute ledger and run history;
- apply the user's extension settings; and
- export or restore a backup when the user requests it.

**My Posts** uses locally imported post data to provide date and type filters, literal text search, and JSON / Markdown exports. These operations run on the user's device.

Xpert does not use data for advertising, profiling, creditworthiness, lending, or purposes unrelated to its single purpose.

## Storage and Retention

Settings, X handles, numeric user identifiers, mute ledger entries, queue state, and run history are stored locally on the user's device using `chrome.storage.local`. A successful Unmute removes the corresponding mute ledger entry.

The current muted-word batch, its target account, options, and per-word results are also stored locally. A new batch replaces the previous completed batch record. **Clear batch results** in **Muted Words** removes this local batch record. The native word list is read from X for display and reconciliation; X stores and applies the actual rules and their expiration times. Native word rules are managed through X or Xpert's **Muted Words** view and remain separate from Xpert's account-ledger JSON backup.

The developer does not operate a server that receives or stores this extension data. Local account records and settings remain until cleared in **Backup & Restore**. Keyword batch records remain until replaced or cleared in **Muted Words**. Clearing the extension's storage or uninstalling it removes all of these local records.

When the user downloads a JSON backup, the file is created locally and is controlled by the user. Xpert does not upload backup files to the developer.

**My Posts** stores its account, posts, and recent import reports in a separate IndexedDB database on the device. **Clear local post library** removes this database's records. Its JSON / Markdown exports are generated locally; the account-ledger backup remains separate. Original image and video files stay in the user's downloaded X archive, while My Posts stores media links. Clearing extension data or uninstalling the extension removes the local post library; downloaded export files remain under the user's control.

## Data Transmission and Sharing

When the user requests a mute or unmute action, Xpert sends the required account identifier and X session authentication information directly to `https://x.com` over HTTPS. This transmission is necessary for X to perform the requested action and is governed by X's own terms and privacy practices.

When the user connects to or manages muted words, Xpert communicates directly with X using the current signed-in session. Requested additions send the chosen words, scope, and duration; edits and removals send native word identifiers and the requested changes. These requests go to X over HTTPS. The developer receives none of this data.

Xpert does not:

- send extension data to a developer-controlled server;
- sell user data;
- share user data with data brokers or advertisers;
- use third-party analytics; or
- allow the developer or other humans to read locally stored extension data.

## Permissions

My Posts imports, filters, searches, and exports local files on the device. Opening a post or media link navigates to its external site through the user's browser.

Xpert uses the following Chrome permissions:

- **`storage`:** stores settings, user-provided account handles, account and word batch progress, run history, and the mute ledger locally.
- **`alarms`:** schedules the next item in user-started account and word batches.
- **Host access to `x.com` and `twitter.com`:** places Mute controls on supported X pages, reads explicitly selected post text, identifies the relevant X account, and performs account actions and native muted-word operations requested by the user.

Xpert ships its own scripts with the extension. On X settings pages, a limited helper uses X's already-loaded request-metadata function to prepare identifiers for the four native muted-word operations. This helper returns only the request identifier; the isolated extension script performs account checks and the requested operation. The helper's messages contain the fixed endpoint, HTTP method, and a correlation identifier. Words, account identifiers, and session credentials stay out of these helper messages.

## User Choices and Control

Users can:

- choose where Xpert displays Mute controls;
- undo a recent mute or unmute an account from the local ledger;
- stop bulk queue processing and clear completed queue items;
- review words before adding them, pause or resume a word batch, edit or remove native rules, and clear local word batch results;
- export a local JSON backup;
- clear the local mute ledger;
- reset extension settings;
- clear all extension storage through Chrome; or
- uninstall Xpert to remove its locally stored data.

Clearing Xpert's local records does not unmute accounts on X. Users can manage their actual muted-account list through X.

## Chrome Web Store Limited Use

Xpert's use and transfer of information received from Chrome APIs adheres to the Chrome Web Store User Data Policy, including its Limited Use requirements.

## Changes to This Policy

This policy may be updated when Xpert's functionality or data practices change. Material changes will be reflected in this document and, when required, in the Chrome Web Store listing.

## Contact

For privacy questions or requests, open an issue in the [Xpert GitHub repository](https://github.com/timerring/x-one-click-block/issues). Do not include passwords, session tokens, or other sensitive information in a public issue.
