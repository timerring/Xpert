globalThis.XMuteStorage.getState().then((state) => {
  const account = state.accounts[state.currentViewer] || { muted: [] };
  document.querySelector("#viewer").textContent = state.currentViewer === "default" ? "X account not detected" : `@${state.currentViewer}`;
  document.querySelector("#muted").textContent = account.muted.length;
  document.querySelector("#pending").textContent = state.queue.items.filter((item) => item.status === "pending" || item.status === "active").length;
});

document.querySelector("#open-options").addEventListener("click", async () => {
  await chrome.runtime.openOptionsPage();
  window.close();
});
