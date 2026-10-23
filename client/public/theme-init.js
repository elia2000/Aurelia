// Runs before the first paint (a plain, blocking script in <head>): puts the
// dark theme on <html> straight away so a person who chose dark never sees a
// white flash. It is a separate file, not inline in index.html, because the
// server's Content-Security-Policy allows no inline scripts. The same key is
// written by client/src/App.jsx.
(function () {
  try {
    var stored = localStorage.getItem("songbird-theme");
    var isDark = stored === "dark";
    if (isDark) {
      var root = document.documentElement;
      root.classList.add("dark", "sb-preload-dark");
      root.style.colorScheme = "dark";
      root.style.backgroundColor = "#020617";
      var meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute("content", "#020617");
    }
  } catch (_) {}
})();
