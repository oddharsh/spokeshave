// A synthetic island in the shape the renamer was built on: closures that
// repeat the same idioms under different names.
(() => {
  function escapeHtml(text) {
    return String(text ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
  function formatBytes(count) {
    return count == null
      ? "?"
      : count < 1024
        ? count + " B"
        : count < 1048576
          ? (count / 1024).toFixed(1) + " KB"
          : (count / 1048576).toFixed(1) + " MB";
  }
  function row(label, value) {
    return (
      "<tr><th>" +
      escapeHtml(label) +
      "</th><td>" +
      escapeHtml(value) +
      "</td></tr>"
    );
  }
  function table(entries) {
    return (
      "<table>" +
      entries
        .map((entry) => row(entry.name, formatBytes(entry.size)))
        .join("") +
      "</table>"
    );
  }
  function wireButtons(root) {
    root.querySelectorAll("button[data-open]").forEach((button) => {
      button.addEventListener("click", (event) => {
        const target = document.getElementById(button.dataset.open);
        if (target) target.hidden = !target.hidden;
        event.preventDefault();
      });
    });
    root.querySelectorAll("button[data-copy]").forEach((button) => {
      button.addEventListener("click", (event) => {
        const source = document.getElementById(button.dataset.copy);
        if (source) navigator.clipboard.writeText(source.textContent);
        event.preventDefault();
      });
    });
  }
  function mount(root, entries) {
    root.innerHTML = table(entries);
    wireButtons(root);
    return {
      refresh: (next) => (root.innerHTML = table(next)),
      size: () => entries.reduce((sum, entry) => sum + entry.size, 0),
    };
  }
  window.Fixture = { mount, formatBytes, escapeHtml };
})();
