# Xpert Privacy Policy

**Effective date:** July 30, 2026

Xpert is a Chrome extension that adds one-click and bulk account muting controls to X. This Privacy Policy explains what data Xpert handles, why it is needed, where it is stored, and the choices available to users.

Xpert is an independent project and is not affiliated with, endorsed by, or sponsored by X Corp.

## Data Xpert Handles

Xpert handles only the data needed to provide its user-facing muting and local record-keeping features:

- **X account identifiers:** X handles, the currently signed-in X handle, and numeric X user identifiers displayed on supported X pages or supplied by the user.
- **Authentication information:** Xpert reads X's `ct0` CSRF token from the current X page only when performing a mute action requested by the user. The token is not saved in Xpert's local records or sent to the developer.
- **X page context and website content:** Xpert reads limited information from supported `x.com` and `twitter.com` pages, including the current route and account identifiers present in the page, to place Mute controls beside the correct accounts.
- **User activity related to Xpert:** requested mute actions, timestamps, action sources, bulk queue status, and bulk run history.
- **Extension settings and user-provided data:** button-placement preferences, queue delay settings, and X handles or X links entered or imported by the user.

Xpert does not collect health information, financial or payment information, precise location, or personal communications.

## How the Data Is Used

Xpert uses this data only to:

- display Mute controls on supported X pages;
- send a mute request to X when the user explicitly requests it;
- process user-created bulk mute queues;
- maintain a local mute ledger and run history;
- apply the user's extension settings; and
- export or restore a backup when the user requests it.

Xpert does not use data for advertising, profiling, creditworthiness, lending, or purposes unrelated to its single purpose.

## Storage and Retention

Settings, X handles, mute ledger entries, queue state, and run history are stored locally on the user's device using `chrome.storage.local`.

The developer does not operate a server that receives or stores this extension data. Locally stored data remains until the user clears it in Xpert's **Backup & Restore** page, clears the extension's storage, or uninstalls the extension.

When the user downloads a JSON backup, the file is created locally and is controlled by the user. Xpert does not upload backup files to the developer.

## Data Transmission and Sharing

When the user requests a mute action, Xpert sends the required account identifier and X session authentication information directly to `https://x.com` over HTTPS. This transmission is necessary for X to perform the requested mute and is governed by X's own terms and privacy practices.

Xpert does not:

- send extension data to a developer-controlled server;
- sell user data;
- share user data with data brokers or advertisers;
- use third-party analytics; or
- allow the developer or other humans to read locally stored extension data.

## Permissions

Xpert uses the following Chrome permissions:

- **`storage`:** stores settings, user-provided account handles, queue state, run history, and the mute ledger locally.
- **`alarms`:** schedules the next item in a user-started bulk mute queue so processing can continue when the extension service worker is suspended.
- **`tabs`:** opens inactive X profile tabs for a user-started bulk mute queue, waits for those pages to load, sends the requested action, and closes the temporary tabs.
- **Host access to `x.com` and `twitter.com`:** places Mute controls on supported X pages, identifies the relevant X account, and performs mute actions explicitly requested by the user.

Xpert does not download or execute remotely hosted JavaScript or WebAssembly.

## User Choices and Control

Users can:

- choose where Xpert displays Mute controls;
- stop bulk queue processing and clear completed queue items;
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
