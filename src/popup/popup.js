globalThis.XBlockStorage.getState().then((state) => {
  const account = state.accounts[state.currentViewer] || { blocked: [], muted: [] };
  document.querySelector("#viewer").textContent = state.currentViewer === "default" ? "尚未识别 X 身份" : `@${state.currentViewer}`;
  document.querySelector("#blocked").textContent = account.blocked.length;
  document.querySelector("#muted").textContent = account.muted.length;
  document.querySelector("#pending").textContent = state.queue.items.filter((item) => item.status === "pending" || item.status === "active").length;
});

document.querySelector("#open-options").addEventListener("click", async () => {
  await chrome.runtime.openOptionsPage();
  window.close();
});
