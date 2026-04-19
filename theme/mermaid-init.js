// Lazy-load Mermaid from CDN only on pages that actually contain diagrams.
// Saves ~2.4MB of JS on every page that has no mermaid blocks (which is most of them).
(() => {
    const mermaidBlocks = document.getElementsByClassName('mermaid');
    if (mermaidBlocks.length === 0) {
        return;
    }

    const darkThemes = ['ayu', 'navy', 'coal'];
    const classList = document.getElementsByTagName('html')[0].classList;

    let lastThemeWasLight = true;
    for (const cssClass of classList) {
        if (darkThemes.includes(cssClass)) {
            lastThemeWasLight = false;
            break;
        }
    }
    const theme = lastThemeWasLight ? 'default' : 'dark';

    // Dynamic import: browser pulls Mermaid only when needed, cached by CDN across pages.
    // Pinned to a major version for reproducibility; jsdelivr honors subresource caching.
    const MERMAID_URL = 'https://cdn.jsdelivr.net/npm/mermaid@10.9.1/dist/mermaid.esm.min.mjs';

    import(MERMAID_URL).then(({ default: mermaid }) => {
        mermaid.initialize({ startOnLoad: true, theme });

        // Re-render when the user toggles light/dark theme.
        const reloadOnThemeChange = (expectLight) => {
            return () => {
                if (lastThemeWasLight === expectLight) {
                    window.location.reload();
                }
            };
        };

        const lightThemes = ['light', 'rust'];
        for (const darkTheme of darkThemes) {
            const el = document.getElementById(darkTheme);
            if (el) el.addEventListener('click', reloadOnThemeChange(true));
        }
        for (const lightTheme of lightThemes) {
            const el = document.getElementById(lightTheme);
            if (el) el.addEventListener('click', reloadOnThemeChange(false));
        }
    }).catch((err) => {
        console.error('Failed to load Mermaid from CDN:', err);
    });
})();
