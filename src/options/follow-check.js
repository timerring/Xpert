(() => {
  "use strict";

  const get = (name) => document.getElementById(`follow-${name}`);
  const pageSize = 50;
  let report;
  let page = 0;

  function render() {
    const ids = report[get("category").value];
    const pages = Math.max(1, Math.ceil(ids.length / pageSize));
    get("owner").textContent = `Archive for ${report.owner}`;
    get("count").textContent = `${ids.length.toLocaleString()} accounts in this list`;
    get("results").replaceChildren(...ids.slice(page * pageSize, (page + 1) * pageSize).map((id) => {
      const row = document.createElement("li");
      const link = document.createElement("a");
      link.href = `https://x.com/i/user/${id}`;
      link.target = "_blank";
      link.rel = "noreferrer";
      link.textContent = `Open account ${id} ↗`;
      row.append(link);
      return row;
    }));
    get("page").textContent = `Page ${page + 1} of ${pages}`;
    get("prev").disabled = page === 0;
    get("next").disabled = page + 1 >= pages;
  }

  const sources = ["zip", "folder"];
  async function load(event) {
    const files = Array.from(event.target.files);
    event.target.value = "";
    if (!files.length) return;
    for (const source of sources) get(`choose-${source}`).disabled = true;
    get("report").hidden = true;
    report = undefined;
    get("status").textContent = "Reading follower and following data…";
    try {
      report = await XpertFollowCheck.read(files);
      page = 0;
      get("category").value = "followingOnly";
      render();
      get("report").hidden = false;
      get("status").textContent = "Archive comparison ready.";
    } catch (error) {
      get("status").textContent = error.message;
    } finally {
      for (const source of sources) get(`choose-${source}`).disabled = false;
    }
  }

  for (const source of sources) {
    get(`choose-${source}`).addEventListener("click", () => get(source).click());
    get(source).addEventListener("change", load);
  }
  get("category").addEventListener("change", () => { page = 0; render(); });
  get("prev").addEventListener("click", () => { page--; render(); });
  get("next").addEventListener("click", () => { page++; render(); });
})();
