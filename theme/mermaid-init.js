// Mermaid init for mdBook. Based on the stock script shipped by
// `mdbook-mermaid install`, with theme-aware initialization and slightly
// tuned flowchart spacing to improve readability of dense diagrams.

(() => {
    const darkThemes = ['ayu', 'navy', 'coal'];
    const lightThemes = ['light', 'rust'];

    const classList = document.getElementsByTagName('html')[0].classList;

    let lastThemeWasLight = true;
    for (const cssClass of classList) {
        if (darkThemes.includes(cssClass)) {
            lastThemeWasLight = false;
            break;
        }
    }

    const theme = lastThemeWasLight ? 'default' : 'dark';
    mermaid.initialize({
        startOnLoad: true,
        theme,
        themeVariables: {
            fontSize: '16px',
        },
        flowchart: {
            nodeSpacing: 50,
            rankSpacing: 50,
            htmlLabels: true,
            curve: 'basis',
        },
        sequence: {
            useMaxWidth: true,
        },
        securityLevel: 'loose',
    });

    // Simplest way to make mermaid re-render diagrams in the new theme is
    // to refresh the page when the reader toggles between light and dark.
    const safeBind = (id, handler) => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('click', handler);
    };

    for (const darkTheme of darkThemes) {
        safeBind(darkTheme, () => {
            if (lastThemeWasLight) window.location.reload();
        });
    }

    for (const lightTheme of lightThemes) {
        safeBind(lightTheme, () => {
            if (!lastThemeWasLight) window.location.reload();
        });
    }
})();
