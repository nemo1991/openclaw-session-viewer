export function applyTheme(theme: "dark" | "light" | "system") {
  if (theme === "system") {
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    document.documentElement.dataset.theme = prefersDark ? "dark" : "light";
  } else {
    document.documentElement.dataset.theme = theme;
  }
}

export function getCurrentTheme(): "dark" | "light" {
  return (document.documentElement.dataset.theme as "dark" | "light") || "dark";
}
