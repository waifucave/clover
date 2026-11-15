// The Theme choice in Settings (light, dark or the OS's) as Electron's `nativeTheme.themeSource`: one value that every
// window follows, in `prefers-color-scheme` and in the theme tokens main serves (`syncAppearance` reads
// `shouldUseDarkColors`, which this moves). Anything that is not exactly "light" or "dark" is the OS's choice.
export type ThemeSource = "light" | "dark" | "system";

export const themeSourceOf = (value: unknown): ThemeSource => (value === "light" || value === "dark" ? value : "system");
